from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable
from datetime import datetime, timezone

from .errors import BrowserAgentError
from .models import BrowserAgentLogEntry
from .runtime import DEFAULT_EXECUTABLE_DEPENDENCIES, ExecutableDependencies


async def _terminate(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


async def ensure_codex_login(
    *,
    on_log: Callable[[BrowserAgentLogEntry], None] | None = None,
    timeout_seconds: float = 1800,
    _dependencies: ExecutableDependencies = DEFAULT_EXECUTABLE_DEPENDENCIES,
) -> None:
    """Ensure one reusable ChatGPT OAuth session through Browser Agent CLI."""
    await _run_codex_login_command(
        (),
        on_log=on_log,
        timeout_seconds=timeout_seconds,
        operation="Codex login",
        _dependencies=_dependencies,
    )


async def check_codex_login(
    *,
    timeout_seconds: float = 30,
    _dependencies: ExecutableDependencies = DEFAULT_EXECUTABLE_DEPENDENCIES,
) -> bool:
    """Return whether a reusable Codex ChatGPT session exists without OAuth."""
    stdout = await _run_codex_login_command(
        ("--check",),
        on_log=None,
        timeout_seconds=timeout_seconds,
        operation="Codex login check",
        _dependencies=_dependencies,
    )
    try:
        payload = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BrowserAgentError(
            "CODEX_AUTH_FAILED", "Codex login check returned invalid output.",
            cause=error,
        ) from error
    if not isinstance(payload, dict) or not isinstance(payload.get("loggedIn"), bool):
        raise BrowserAgentError(
            "CODEX_AUTH_FAILED", "Codex login check returned invalid output."
        )
    return payload["loggedIn"]


async def _run_codex_login_command(
    arguments: tuple[str, ...],
    *,
    on_log: Callable[[BrowserAgentLogEntry], None] | None,
    timeout_seconds: float,
    operation: str,
    _dependencies: ExecutableDependencies,
) -> bytes:
    if timeout_seconds <= 0:
        raise BrowserAgentError(
            "CONFIG_INVALID", "timeout_seconds must be greater than zero."
        )

    executable = await _dependencies.resolve()
    await _dependencies.verify(executable)
    try:
        process = await asyncio.create_subprocess_exec(
            executable,
            "codex-login",
            *arguments,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=os.environ.copy(),
        )
    except OSError as error:
        raise BrowserAgentError(
            "CODEX_AUTH_FAILED",
            f"{operation} could not start Browser Agent.",
            cause=error,
        ) from error

    assert process.stdout is not None
    assert process.stderr is not None

    async def consume_stderr() -> None:
        while line := await process.stderr.readline():
            try:
                if on_log:
                    on_log(
                        BrowserAgentLogEntry(
                            "codex-login",
                            line.decode(errors="replace").rstrip("\r\n"),
                            datetime.now(timezone.utc),
                        )
                    )
            except BaseException:
                pass

    stdout_task = asyncio.create_task(process.stdout.read())
    stderr_task = asyncio.create_task(consume_stderr())
    try:
        await asyncio.wait_for(process.wait(), timeout=timeout_seconds)
    except asyncio.TimeoutError as error:
        await _terminate(process)
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        raise BrowserAgentError(
            "CODEX_AUTH_FAILED",
            f"{operation} timed out after {timeout_seconds:g}s.",
            cause=error,
        ) from error

    stdout, _ = await asyncio.gather(stdout_task, stderr_task)
    if process.returncode != 0:
        raise BrowserAgentError(
            "CODEX_AUTH_FAILED", f"{operation} failed."
        )
    return stdout
