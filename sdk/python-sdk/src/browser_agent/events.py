import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Generic, Literal, TypeAlias, TypeVar

from .errors import BrowserAgentError
from .models import BrowserAgentResult, BrowserAgentTaskResult, UserTakeoverCategory
@dataclass(frozen=True, slots=True)
class RunStartedEvent:
    run_id: str
    type: Literal["run_started"] = "run_started"
@dataclass(frozen=True, slots=True)
class UserTakeoverEvent:
    run_id: str
    task_id: str
    reason: str
    category: UserTakeoverCategory
    type: Literal["user_takeover"] = "user_takeover"
@dataclass(frozen=True, slots=True)
class TaskResultEvent:
    run_id: str
    result: BrowserAgentTaskResult
    type: Literal["task_result"] = "task_result"
@dataclass(frozen=True, slots=True)
class RunCompletedEvent:
    run_id: str
    result: BrowserAgentResult
    type: Literal["run_completed"] = "run_completed"
@dataclass(frozen=True, slots=True)
class ErrorEvent:
    run_id: str
    error: BrowserAgentError
    type: Literal["error"] = "error"
BrowserAgentEvent: TypeAlias = (
    RunStartedEvent
    | UserTakeoverEvent
    | TaskResultEvent
    | RunCompletedEvent
    | ErrorEvent
)
T = TypeVar("T")
class ReplayEvents(Generic[T]):
    def __init__(self) -> None:
        self._items: list[T] = []
        self._waiters: set[asyncio.Future[None]] = set()
        self._closed = False
    def publish(self, item: T) -> None:
        if self._closed:
            return
        self._items.append(item)
        self._wake()
    def close(self) -> None:
        self._closed = True
        self._wake()
    async def iterate(self) -> AsyncIterator[T]:
        index = 0
        while True:
            while index < len(self._items):
                yield self._items[index]
                index += 1
            if self._closed:
                return
            waiter = asyncio.get_running_loop().create_future()
            self._waiters.add(waiter)
            try:
                await waiter
            finally:
                self._waiters.discard(waiter)
    def _wake(self) -> None:
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_result(None)
        self._waiters.clear()
