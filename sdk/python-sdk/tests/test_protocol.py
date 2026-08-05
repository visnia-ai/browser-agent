from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from browser_agent.protocol import (
    AgentProcess,
    consume_logs,
    request_run,
    start_agent_process,
    terminate_process,
)
from tests.helpers import FAKE_EXECUTABLE


def config() -> str:
    descriptor, filename = tempfile.mkstemp(prefix="py-sdk-config-")
    with os.fdopen(descriptor, "w") as output:
        json.dump({"tasks": []}, output)
    return filename


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_starts_requests_reads_messages_and_logs(self) -> None:
        filename = config()
        try:
            process = await start_agent_process(
                FAKE_EXECUTABLE,
                filename,
                {**os.environ, "SDK_FAKE_MODE": "success"},
            )
            await request_run(process)
            messages = [message async for message in process.messages()]
            logs = [line async for line in process.logs()]
            self.assertEqual(messages[0]["id"], 1)
            self.assertTrue(logs)
            self.assertEqual(await process.process.wait(), 0)
            await terminate_process(process)
        finally:
            Path(filename).unlink(missing_ok=True)

    async def test_rejects_malformed_and_invalid_messages(self) -> None:
        for mode in ("malformed", "invalid-message"):
            filename = config()
            process = await start_agent_process(
                FAKE_EXECUTABLE,
                filename,
                {**os.environ, "SDK_FAKE_MODE": mode},
            )
            await request_run(process)
            with self.assertRaisesRegex(Exception, "JSON-RPC"):
                _ = [message async for message in process.messages()]
            await terminate_process(process)
            Path(filename).unlink(missing_ok=True)

    async def test_start_failure_and_termination_paths(self) -> None:
        with self.assertRaisesRegex(Exception, "could not be started"):
            await start_agent_process("/definitely/missing", "config", {})

        exited = Mock(returncode=0)
        await terminate_process(AgentProcess(exited))
        exited.terminate.assert_not_called()

        graceful = Mock(returncode=None)
        graceful.wait = AsyncMock(return_value=0)
        await terminate_process(AgentProcess(graceful), 0.01)
        graceful.terminate.assert_called_once()

        forced = Mock(returncode=None)
        forced.wait = AsyncMock(side_effect=[asyncio.TimeoutError, 0])
        await terminate_process(AgentProcess(forced), 0.001)
        forced.kill.assert_called_once()

    async def test_redacts_logs_and_isolates_callbacks(self) -> None:
        class FakeProcess:
            async def logs(self):
                yield "secret /private"
                yield "second"

        messages = []

        def callback(entry):
            messages.append(entry.message)
            if len(messages) == 2:
                raise RuntimeError("consumer")

        await consume_logs(FakeProcess(), "run", callback, ["secret"], ["/private"])
        self.assertEqual(messages, ["<redacted> <internal>", "second"])
        await consume_logs(FakeProcess(), "run", None, [], [])
