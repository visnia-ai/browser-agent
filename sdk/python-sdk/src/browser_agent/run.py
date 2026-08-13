from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import suppress
from datetime import datetime, timezone

from .errors import BrowserAgentError, normalize_error
from .events import BrowserAgentEvent, ErrorEvent, ReplayEvents, RunCompletedEvent
from .models import (
    BrowserAgentLogEntry,
    BrowserAgentResult,
    BrowserAgentTask,
    Provider,
    ReasoningEffort,
    ValidatorLifecycleMode,
)
from .options import ResolvedOptions, child_environment, normalize_tasks, resolve_options
from .protocol import AgentProcess, consume_logs, request_run, start_agent_process, terminate_process
from .rpc import RpcState
from .runtime import (
    DEFAULT_EXECUTABLE_DEPENDENCIES,
    ExecutableDependencies,
    RuntimeFiles,
    create_runtime_files,
)


class BrowserAgent:
    def __init__(
        self, *, provider: Provider, model: str, download_directory: str,
        reasoning_effort: ReasoningEffort | None = None, api_key: str | None = None,
        endpoint_url: str | None = None, openrouter_provider: str | None = None,
        max_model_len: int = 48_000, reserve_output_tokens: int = 4_000,
        headless: bool = False,
        executable_path: str | None = None, workspace_directory: str | None = None,
        browser_profile_directory: str | None = None,
        user_takeover_tool: bool = False, max_steps: int = 50, concurrency: int = 8,
        runs_per_task: int = 1, retry_count: int = 2,
        validator_lifecycle: ValidatorLifecycleMode = "retry",
        on_log: Callable[[BrowserAgentLogEntry], None] | None = None,
    ) -> None:
        self._options = resolve_options(**locals())
        self._dependencies: ExecutableDependencies = DEFAULT_EXECUTABLE_DEPENDENCIES
        self._executable: asyncio.Future[str] | None = None

    def run(
        self, value: BrowserAgentTask | Sequence[BrowserAgentTask], *,
        on_event: Callable[[BrowserAgentEvent], None] | None = None,
    ) -> BrowserAgentRun:
        tasks = normalize_tasks(value)
        try:
            asyncio.get_running_loop()
        except RuntimeError as error:
            raise BrowserAgentError(
                "PROCESS_START_FAILED",
                "run() must be called inside an active asyncio event loop.",
            ) from error
        if self._executable is None:
            self._executable = asyncio.create_task(self._verify())
        return BrowserAgentRun(
            str(uuid.uuid4()), self._options, tasks, self._executable, on_event
        )

    async def _verify(self) -> str:
        executable = await self._dependencies.resolve()
        await self._dependencies.verify(executable)
        return executable


class BrowserAgentRun:
    def __init__(
        self, run_id: str, options: ResolvedOptions, tasks: list[BrowserAgentTask],
        executable: asyncio.Future[str],
        on_event: Callable[[BrowserAgentEvent], None] | None,
    ) -> None:
        self.id, self._options, self._tasks = run_id, options, tasks
        self._on_event = on_event
        self._stream = ReplayEvents[BrowserAgentEvent]()
        self._process: AgentProcess | None = None
        self._terminal: asyncio.Future[str] | None = None
        self._cancel_requested = False
        self._rpc: RpcState | None = None
        self.result = asyncio.create_task(self._execute(executable))

    def events(self) -> AsyncIterator[BrowserAgentEvent]:
        return self._stream.iterate()

    async def cancel(self) -> None:
        self._cancel_requested = True
        self._settle("cancelled")
        if self._process:
            await terminate_process(self._process)
        with suppress(BaseException):
            await self.result

    def _publish(self, event: BrowserAgentEvent) -> None:
        self._stream.publish(event)
        try:
            if self._on_event:
                self._on_event(event)
        except BaseException:
            pass

    def _complete(self, status: str, started: datetime) -> BrowserAgentResult:
        result = BrowserAgentResult(
            self.id, status, self._rpc.results if self._rpc else (),
            started, datetime.now(timezone.utc),
        )
        self._publish(RunCompletedEvent(self.id, result))
        self._stream.close()
        return result

    def _settle(self, value: str | BaseException) -> None:
        if not self._terminal or self._terminal.done():
            return
        if isinstance(value, BaseException):
            self._terminal.set_exception(value)
        else:
            self._terminal.set_result(value)

    async def _pump(self, process: AgentProcess) -> None:
        try:
            async for message in process.messages():
                event = self._rpc.handle(message)
                if event == "complete":
                    self._settle("completed")
                elif event:
                    self._publish(event)
        except BaseException as error:
            self._settle(error)

    async def _watch_exit(self, process: AgentProcess) -> None:
        await process.process.wait()
        self._settle(
            "cancelled" if self._cancel_requested else
            BrowserAgentError("PROCESS_EXITED", "browser-agent exited early.")
        )

    async def _execute(self, executable: asyncio.Future[str]) -> BrowserAgentResult:
        started, files = datetime.now(timezone.utc), None
        secrets = ([self._options.api_key] if self._options.api_key else []) + [
            value
            for task in self._tasks
            for credential in task.credentials
            for value in (credential.username, credential.password, credential.domain)
        ]
        try:
            binary = await executable
            if self._cancel_requested:
                return self._complete("cancelled", started)
            files = create_runtime_files(self._options, self._tasks)
            self._process = await start_agent_process(
                binary, files.config_path, child_environment(self._options)
            )
            self._rpc = RpcState(self.id, secrets, files.internal_paths)
            logs = asyncio.create_task(consume_logs(
                self._process, self.id, self._options.on_log, secrets, files.internal_paths
            ))
            self._terminal = asyncio.get_running_loop().create_future()
            asyncio.create_task(self._pump(self._process))
            asyncio.create_task(self._watch_exit(self._process))
            await request_run(self._process, self._tasks)
            outcome = await self._terminal
            if outcome == "cancelled":
                await terminate_process(self._process)
            else:
                if await self._process.process.wait() != 0:
                    raise BrowserAgentError(
                        "PROCESS_EXITED", "browser-agent exited unsuccessfully."
                    )
                if len(self._rpc.results) != len(self._tasks):
                    raise BrowserAgentError(
                        "PROTOCOL_ERROR", "browser-agent completed without all task results."
                    )
            await logs
            files.cleanup()
            files = None
            status = "cancelled" if outcome == "cancelled" else (
                "failed" if any(item.status == "failed" for item in self._rpc.results)
                else "completed"
            )
            return self._complete(status, started)
        except BaseException as error:
            if self._process:
                await terminate_process(self._process)
            if files:
                files.cleanup()
            normalized = normalize_error(
                error, "PROCESS_EXITED", secrets, files.internal_paths if files else []
            )
            self._publish(ErrorEvent(self.id, normalized))
            self._stream.close()
            raise normalized
        finally:
            self._terminal = None
