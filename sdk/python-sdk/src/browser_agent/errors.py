from dataclasses import dataclass
from typing import Literal

BrowserAgentErrorCode = Literal[
    "CLI_NOT_FOUND", "CLI_VERSION_INCOMPATIBLE", "CHROME_NOT_FOUND", "CONFIG_INVALID",
    "PROCESS_START_FAILED", "PROCESS_EXITED", "PROTOCOL_ERROR", "CANCELLED",
]
@dataclass(frozen=True, slots=True)
class BrowserAgentError(Exception):
    code: BrowserAgentErrorCode
    message: str
    details: dict[str, object] | None = None
    cause: object | None = None

    def __post_init__(self) -> None:
        Exception.__init__(self, self.message)
def redact(value: str, secrets: list[str], paths: list[str]) -> str:
    result = value
    for secret in secrets:
        if secret:
            result = result.replace(secret, "<redacted>")
    for internal_path in paths:
        if internal_path:
            result = result.replace(internal_path, "<internal>")
    return result
def normalize_error(
    error: BaseException, code: BrowserAgentErrorCode,
    secrets: list[str], paths: list[str],
) -> BrowserAgentError:
    if isinstance(error, BrowserAgentError):
        return error
    message = redact(str(error), secrets, paths)
    return BrowserAgentError(code, message, cause=RuntimeError(message))
