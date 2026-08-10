from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from browser_agent import BrowserAgentError, check_codex_login, ensure_codex_login
from browser_agent.runtime import ExecutableDependencies, verify_executable
from tests.helpers import FAKE_EXECUTABLE, fake_environment


async def resolve_fake() -> str:
    return FAKE_EXECUTABLE


DEPENDENCIES = ExecutableDependencies(resolve_fake, verify_executable)


class CodexLoginTests(unittest.IsolatedAsyncioTestCase):
    async def test_checks_logged_in_and_logged_out_without_interactive_output(self) -> None:
        for mode, expected in (("success", True), ("auth-logged-out", False)):
            with fake_environment(mode):
                logged_in = await check_codex_login(
                    timeout_seconds=5,
                    _dependencies=DEPENDENCIES,
                )
            self.assertEqual(logged_in, expected)

    async def test_check_maps_nonzero_exit_and_timeout(self) -> None:
        with fake_environment("auth-fail"):
            with self.assertRaises(BrowserAgentError) as failed:
                await check_codex_login(
                    timeout_seconds=5, _dependencies=DEPENDENCIES
                )
        self.assertEqual(failed.exception.code, "CODEX_AUTH_FAILED")

        with fake_environment("auth-wait"):
            with self.assertRaises(BrowserAgentError) as timed_out:
                await check_codex_login(
                    timeout_seconds=0.01, _dependencies=DEPENDENCIES
                )
        self.assertEqual(timed_out.exception.code, "CODEX_AUTH_FAILED")
        self.assertIn("timed out", timed_out.exception.message)

    async def test_relays_login_and_runs_command_once(self) -> None:
        logs: list[str] = []
        with tempfile.TemporaryDirectory() as temporary:
            count = Path(temporary) / "auth-count"
            with fake_environment(
                "success", SDK_FAKE_AUTH_COUNT=str(count)
            ):
                await ensure_codex_login(
                    on_log=lambda entry: logs.append(entry.message),
                    timeout_seconds=5,
                    _dependencies=DEPENDENCIES,
                )

            self.assertEqual(count.read_text(encoding="utf-8"), "1\n")
        self.assertEqual(logs, ["Codex login preflight"])

    async def test_maps_nonzero_exit_and_timeout(self) -> None:
        with fake_environment("auth-fail"):
            with self.assertRaises(BrowserAgentError) as failed:
                await ensure_codex_login(
                    timeout_seconds=5, _dependencies=DEPENDENCIES
                )
        self.assertEqual(failed.exception.code, "CODEX_AUTH_FAILED")

        with fake_environment("auth-wait"):
            with self.assertRaises(BrowserAgentError) as timed_out:
                await ensure_codex_login(
                    on_log=lambda _: (_ for _ in ()).throw(RuntimeError()),
                    timeout_seconds=0.01,
                    _dependencies=DEPENDENCIES,
                )
        self.assertEqual(timed_out.exception.code, "CODEX_AUTH_FAILED")
        self.assertIn("timed out", timed_out.exception.message)

    async def test_rejects_invalid_timeout(self) -> None:
        with self.assertRaises(BrowserAgentError) as caught:
            await ensure_codex_login(
                timeout_seconds=0, _dependencies=DEPENDENCIES
            )
        self.assertEqual(caught.exception.code, "CONFIG_INVALID")


if __name__ == "__main__":
    unittest.main()
