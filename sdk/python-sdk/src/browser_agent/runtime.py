from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from .errors import BrowserAgentError
from .models import BrowserAgentTask
from .options import ResolvedOptions


CLI_CACHE_ENVIRONMENT_VARIABLE = "BROWSER_AGENT_CLI_CACHE_DIR"
CLI_PATH_ENVIRONMENT_VARIABLE = "BROWSER_AGENT_CLI_PATH"
CLI_DOWNLOAD_TIMEOUT_SECONDS = 120


def platform_key(system: str | None = None, machine: str | None = None) -> str:
    system = system or sys.platform
    machine = (machine or platform.machine()).lower()
    architecture = {
        "aarch64": "arm64",
        "amd64": "x64",
        "x86_64": "x64",
    }.get(machine, machine)
    return f"{system}-{architecture}"


def cli_manifest() -> Path:
    return Path(__file__).parent / "cli-manifest.json"


def cli_cache_directory() -> Path:
    override = os.environ.get(CLI_CACHE_ENVIRONMENT_VARIABLE)
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        root = Path(
            os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")
        )
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Caches"
    else:
        root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return root / "browser-agent"


def cached_executable(
    version: str,
    system: str | None = None,
    machine: str | None = None,
    cache_directory: Path | None = None,
) -> Path:
    system = system or sys.platform
    suffix = ".exe" if system == "win32" else ""
    root = cache_directory or cli_cache_directory()
    return root / version / platform_key(system, machine) / f"browser-agent{suffix}"


def _digest_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as binary:
        for chunk in iter(lambda: binary.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_target(manifest_path: Path, key: str) -> tuple[str, str, str]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        version = manifest["version"]
        target = manifest["platforms"][key]
        url = target["url"]
        checksum = target["sha256"]
        if (
            not isinstance(version, str)
            or not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]*", version)
        ):
            raise ValueError("invalid version")
        if not isinstance(url, str) or not url.startswith("https://github.com/"):
            raise ValueError("invalid URL")
        if not isinstance(checksum, str) or not re.fullmatch(
            r"[a-f0-9]{64}", checksum
        ):
            raise ValueError("invalid checksum")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise BrowserAgentError(
            "CLI_VERSION_INCOMPATIBLE",
            f"Browser-agent release metadata is unavailable for {key}.",
            cause=error,
        ) from error
    return version, url, checksum


def _download_cli(url: str, checksum: str, destination: Path, key: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_value = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    temporary = Path(temporary_value)
    try:
        request = urllib.request.Request(
            url, headers={"User-Agent": "browser-agent-python-sdk"}
        )
        digest = hashlib.sha256()
        with (
            urllib.request.urlopen(
                request, timeout=CLI_DOWNLOAD_TIMEOUT_SECONDS
            ) as response,
            os.fdopen(descriptor, "wb") as output,
        ):
            descriptor = -1
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != checksum:
            raise BrowserAgentError(
                "CLI_VERSION_INCOMPATIBLE",
                f"Downloaded browser-agent checksum verification failed for {key}.",
            )
        if os.name != "nt":
            temporary.chmod(0o755)
        os.replace(temporary, destination)
    except BrowserAgentError:
        raise
    except (OSError, urllib.error.URLError) as error:
        raise BrowserAgentError(
            "CLI_NOT_FOUND",
            f"Unable to download browser-agent for {key}: {error}",
            cause=error,
        ) from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _resolve_managed_executable(
    manifest_path: Path,
    cache_directory: Path | None,
    system: str | None,
    machine: str | None,
) -> Path:
    key = platform_key(system, machine)
    version, url, checksum = _manifest_target(manifest_path, key)
    executable = cached_executable(
        version, system, machine, cache_directory=cache_directory
    )
    try:
        if executable.is_file() and _digest_file(executable) == checksum:
            if os.name != "nt" and not os.access(executable, os.X_OK):
                executable.chmod(0o755)
            return executable
    except OSError:
        pass
    _download_cli(url, checksum, executable, key)
    return executable


async def resolve_executable(
    executable: Path | None = None,
    *,
    manifest: Path | None = None,
    cache_directory: Path | None = None,
    system: str | None = None,
    machine: str | None = None,
) -> str:
    configured = executable or (
        Path(value)
        if (value := os.environ.get(CLI_PATH_ENVIRONMENT_VARIABLE))
        else None
    )
    if configured is not None:
        executable = configured.expanduser().resolve()
    else:
        executable = await asyncio.to_thread(
            _resolve_managed_executable,
            manifest or cli_manifest(),
            cache_directory,
            system,
            machine,
        )
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise BrowserAgentError(
            "CLI_NOT_FOUND",
            f"Browser-agent executable is unavailable for {platform_key(system, machine)}.",
        )
    return str(executable)


async def verify_executable(executable: str, timeout: float = 5) -> None:
    try:
        process = await asyncio.create_subprocess_exec(
            executable, "--version-json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout)
    except TimeoutError as error:
        process.kill()
        await process.wait()
        raise BrowserAgentError(
            "CLI_VERSION_INCOMPATIBLE", "Browser-agent version check timed out."
        ) from error
    except OSError as error:
        raise BrowserAgentError(
            "CLI_NOT_FOUND", "Browser-agent executable could not be started."
        ) from error
    try:
        if process.returncode or json.loads(stdout)["rpcProtocolVersion"] != 1:
            raise ValueError
    except (ValueError, KeyError, json.JSONDecodeError) as error:
        raise BrowserAgentError(
            "CLI_VERSION_INCOMPATIBLE",
            "Browser-agent uses an incompatible RPC protocol.",
        ) from error


@dataclass(frozen=True, slots=True)
class ExecutableDependencies:
    resolve: Callable[[], Awaitable[str]]
    verify: Callable[[str], Awaitable[None]]
DEFAULT_EXECUTABLE_DEPENDENCIES = ExecutableDependencies(
    resolve_executable, verify_executable
)
@dataclass(slots=True)
class RuntimeFiles:
    config_path: str
    internal_paths: list[str]
    def cleanup(self) -> None:
        for owned in self.internal_paths:
            shutil.rmtree(owned, ignore_errors=True)
def create_runtime_files(options: ResolvedOptions, tasks: list[BrowserAgentTask]):
    owned: list[str] = []
    try:
        runtime = tempfile.mkdtemp(prefix="browser-agent-sdk-")
        owned.append(runtime)
        os.chmod(runtime, 0o700)
        workspace = options.workspace_directory
        if workspace is None:
            workspace = tempfile.mkdtemp(prefix=".browser-agent-workspace-", dir=os.getcwd())
            owned.append(workspace)
        Path(options.download_directory).mkdir(parents=True, exist_ok=True)
        Path(workspace).mkdir(parents=True, exist_ok=True)
        config_path = str(Path(runtime) / "config.yaml")
        stage_llm = {
            "provider": options.provider, "model": options.model,
            "reasoning_effort": options.reasoning_effort,
            "max_model_len": options.max_model_len,
            "reserve_output_tokens": options.reserve_output_tokens,
            **({"endpoint_url": options.endpoint_url} if options.endpoint_url else {}),
            **({"openrouter_provider": options.openrouter_provider}
               if options.openrouter_provider else {}),
        }
        find_target_url_stage_llm = {**stage_llm, "reasoning_effort": "none"}
        config = {
            "stage_llms": {
                "findTargetURL": find_target_url_stage_llm,
                "createChecklist": stage_llm,
                "runAgent": stage_llm,
                "verifySuccess": stage_llm,
                "dataExtraction": stage_llm,
            },
            "feature_flags": {
                "workflow_orchestration": False,
                "pre_step_screenshot_in_latest_user_prompt": False,
                "user_takeover_tool": options.user_takeover_tool,
                "auth_takeover": True,
                "agent_takeover_tool": False,
                "extract_data_whole_context": True,
                "semantic_projection_history": "current",
                "optimize_executor_step_delays": False,
                "optimize_text_input": False,
            },
            "headless": options.headless,
            **({"executable_path": options.executable_path} if options.executable_path else {}),
            "download_dir": options.download_directory, "file_workspace_root": workspace,
            **({"browser_profiles": {
                "mode": "seeded",
                "seed_user_data_dir": options.browser_profile_directory,
                "per_worker_user_data_root": str(Path(runtime) / "browser-profiles"),
                "reuse_existing_worker_profiles": False,
            }} if options.browser_profile_directory else {}),
            "max_steps": options.max_steps, "concurrency": options.concurrency,
            "task_runs": options.runs_per_task, "task_run_retry_count": options.retry_count,
            "validator_lifecycle": {
                "mode": options.validator_lifecycle,
                "max_failures": 3,
                "context": "full",
            },
            "wait_between_tasks_ms": 0, "save_steps_context": True, "save_task_logs": True,
            "step_messages_jsonl_path": str(Path(runtime) / "steps.jsonl"),
            "tasks": [{"task": task.task, **({"url": task.url} if task.url else {})}
                      for task in tasks],
        }
        descriptor = os.open(config_path, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(config, output)
        return RuntimeFiles(config_path, owned)
    except BaseException:
        for path in owned:
            shutil.rmtree(path, ignore_errors=True)
        raise
