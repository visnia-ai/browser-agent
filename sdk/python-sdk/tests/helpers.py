from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from browser_agent import BrowserAgent
from browser_agent.runtime import ExecutableDependencies, verify_executable

FAKE_EXECUTABLE = str(
    Path(__file__).parents[2] / "sdk-test-fixtures" / "fake-browser-agent.mjs"
)


async def resolve_fake() -> str:
    return FAKE_EXECUTABLE


def create_agent(
    logs: list[str] | None = None,
    **overrides: object,
) -> BrowserAgent:
    values = {
        "provider": "openai",
        "model": "gpt-5.4",
        "api_key": "sdk-secret",
        "download_directory": str(Path(tempfile.gettempdir()) / "py-sdk-downloads"),
        "on_log": (lambda entry: logs.append(entry.message))
        if logs is not None
        else None,
        **overrides,
    }
    agent = BrowserAgent(**values)  # type: ignore[arg-type]
    agent._dependencies = ExecutableDependencies(resolve_fake, verify_executable)
    return agent


@contextmanager
def fake_environment(mode: str, **values: str) -> Iterator[None]:
    names = {"SDK_FAKE_MODE": mode, **values}
    previous = {name: os.environ.get(name) for name in names}
    os.environ.update(names)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
