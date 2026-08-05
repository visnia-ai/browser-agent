from __future__ import annotations

from dataclasses import replace

from .errors import BrowserAgentError, redact
from .events import RunStartedEvent, TaskResultEvent, UserTakeoverEvent
from .models import (
    BrowserAgentTaskResult,
    BrowserAgentTaskRunResult,
    BrowserAgentValidatorResult,
)

def record(value):
    if not isinstance(value, dict):
        raise BrowserAgentError(
            "PROTOCOL_ERROR", "CLI emitted invalid task-result parameters."
        )
    return value
def normalize_result(value) -> BrowserAgentTaskResult:
    source = record(value)
    task_id, status, raw_runs = (
        source.get("task_id"), source.get("status"), source.get("runs")
    )
    if not isinstance(task_id, str) or status not in ("completed", "failed") \
            or not isinstance(raw_runs, list):
        raise BrowserAgentError(
            "PROTOCOL_ERROR", "CLI emitted invalid task-result parameters."
        )
    runs = []
    for value in raw_runs:
        run = record(value)
        validator = record(run.get("validator"))
        if not isinstance(run.get("run_index"), int) \
                or not isinstance(run.get("completed"), bool) \
                or not isinstance(validator.get("ran"), bool) \
                or not isinstance(validator.get("success"), bool) \
                or not isinstance(validator.get("summary"), str):
            raise BrowserAgentError(
                "PROTOCOL_ERROR", "CLI emitted an invalid task run."
            )
        runs.append(BrowserAgentTaskRunResult(
            run["run_index"], run["completed"], run.get("data"),
            BrowserAgentValidatorResult(
                validator["ran"], validator["success"], validator["summary"]
            ),
        ))
    errors = source.get("errors")
    return BrowserAgentTaskResult(
        task_id, status, tuple(runs),
        tuple(item for item in errors if isinstance(item, str))
        if isinstance(errors, list) else (),
    )
def order(task_id: str) -> int:
    prefix, separator, suffix = task_id.partition("-")
    return int(suffix) if prefix == "task" and separator and suffix.isdigit() else 2**31
class RpcState:
    def __init__(self, run_id: str, secrets: list[str], paths: list[str]) -> None:
        self.run_id, self.secrets, self.paths = run_id, secrets, paths
        self._results: dict[str, BrowserAgentTaskResult] = {}
    @property
    def results(self) -> tuple[BrowserAgentTaskResult, ...]:
        return tuple(sorted(self._results.values(), key=lambda item: order(item.task_id)))
    def handle(self, message: dict[str, object]):
        if message.get("id") == 1:
            return self._accept(message)
        method = message.get("method")
        params = message.get("params")
        source = params if isinstance(params, dict) else {}
        if method == "browser-agent/status":
            category = source.get("category")
            if category not in ("authentication", "otp", "verification", "payment"):
                category = "other"
            return UserTakeoverEvent(
                self.run_id, str(source.get("task_id", "")),
                str(source.get("reason", "")), category
            )
        if method == "browser-agent/task_result":
            result = normalize_result(params)
            result = replace(result, errors=tuple(
                redact(error, self.secrets, self.paths) for error in result.errors
            ))
            self._results[result.task_id] = result
            return TaskResultEvent(self.run_id, result)
        if method == "browser-agent/all_tasks_completed":
            return "complete"
        if method == "browser-agent/error":
            raise BrowserAgentError(
                "PROCESS_EXITED",
                redact(str(source.get("message", "browser-agent failed.")),
                       self.secrets, self.paths),
            )
    def _accept(self, message: dict[str, object]):
        error = message.get("error")
        if isinstance(error, dict):
            data = error.get("data")
            code = data.get("code") if isinstance(data, dict) else None
            code = code if code in ("CONFIG_INVALID", "CHROME_NOT_FOUND") else "PROTOCOL_ERROR"
            raise BrowserAgentError(
                code,
                redact(str(error.get("message", "CLI rejected the run.")),
                       self.secrets, self.paths),
            )
        result = message.get("result")
        if not isinstance(result, dict) or result.get("accepted") is not True:
            raise BrowserAgentError("PROTOCOL_ERROR", "CLI did not accept the run.")
        return RunStartedEvent(self.run_id)
