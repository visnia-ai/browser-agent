from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timezone

from .errors import BrowserAgentError, redact
from .models import BrowserAgentLogEntry, BrowserAgentTask

@dataclass(slots=True)
class AgentProcess:
    process: asyncio.subprocess.Process

    async def messages(self) -> AsyncIterator[dict[str, object]]:
        assert self.process.stdout
        while line := await self.process.stdout.readline():
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise BrowserAgentError(
                    "PROTOCOL_ERROR", "CLI emitted malformed JSON-RPC."
                ) from error
            if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
                raise BrowserAgentError(
                    "PROTOCOL_ERROR", "CLI emitted an invalid JSON-RPC message."
                )
            yield value
    async def logs(self) -> AsyncIterator[str]:
        assert self.process.stderr
        while line := await self.process.stderr.readline():
            yield line.decode(errors="replace").rstrip("\r\n")
async def start_agent_process(
    executable: str, config_path: str, environment: dict[str, str]
) -> AgentProcess:
    try:
        process = await asyncio.create_subprocess_exec(
            executable,
            config_path,
            "--rpc",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
    except OSError as error:
        raise BrowserAgentError(
            "PROCESS_START_FAILED", "browser-agent process could not be started."
        ) from error
    return AgentProcess(process)
async def request_run(
    agent: AgentProcess, tasks: list[BrowserAgentTask] | tuple[BrowserAgentTask, ...] = ()
) -> None:
    assert agent.process.stdin
    rpc_tasks = [
        {"credentials": [
            {"username": value.username, "password": value.password, "domain": value.domain}
            for value in task.credentials
        ]} if task.credentials else {}
        for task in tasks
    ]
    agent.process.stdin.write(
        (
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "browser-agent/run",
                    "params": {"tasks": rpc_tasks} if any(task for task in rpc_tasks) else {},
                }
            )
            + "\n"
        ).encode()
    )
    await agent.process.stdin.drain()
async def terminate_process(agent: AgentProcess, grace: float = 5.0) -> None:
    if agent.process.returncode is not None:
        return
    agent.process.terminate()
    try:
        await asyncio.wait_for(agent.process.wait(), timeout=grace)
    except TimeoutError:
        agent.process.kill()
        await agent.process.wait()
async def consume_logs(
    process: AgentProcess,
    run_id: str,
    callback,
    secrets: list[str],
    paths: list[str],
) -> None:
    async for line in process.logs():
        try:
            if callback:
                callback(BrowserAgentLogEntry(
                    run_id, redact(line, secrets, paths), datetime.now(timezone.utc)
                ))
        except BaseException:
            pass
