from dataclasses import dataclass
from collections.abc import Sequence
from datetime import datetime
from typing import Literal, TypeAlias

Provider: TypeAlias = Literal[
    "openai", "vllm", "together", "anthropic", "google", "openrouter"
]
ReasoningEffort: TypeAlias = Literal[
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "enabled"
]
UserTakeoverCategory: TypeAlias = Literal[
    "authentication", "otp", "verification", "payment", "other"
]
@dataclass(frozen=True, slots=True)
class BrowserAgentCredential:
    username: str
    password: str
    domain: str
@dataclass(frozen=True, slots=True)
class BrowserAgentTask:
    task: str
    url: str | None = None
    credentials: Sequence[BrowserAgentCredential] = ()
@dataclass(frozen=True, slots=True)
class BrowserAgentLogEntry:
    run_id: str
    message: str
    timestamp: datetime
    source: Literal["stderr"] = "stderr"
@dataclass(frozen=True, slots=True)
class BrowserAgentValidatorResult:
    ran: bool
    success: bool
    summary: str
@dataclass(frozen=True, slots=True)
class BrowserAgentTaskRunResult:
    run_index: int
    completed: bool
    data: object
    validator: BrowserAgentValidatorResult
@dataclass(frozen=True, slots=True)
class BrowserAgentTaskResult:
    task_id: str
    status: Literal["completed", "failed"]
    runs: tuple[BrowserAgentTaskRunResult, ...]
    errors: tuple[str, ...]
@dataclass(frozen=True, slots=True)
class BrowserAgentResult:
    run_id: str
    status: Literal["completed", "failed", "cancelled"]
    tasks: tuple[BrowserAgentTaskResult, ...]
    started_at: datetime
    finished_at: datetime
