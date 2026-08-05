from __future__ import annotations

import unittest
from dataclasses import FrozenInstanceError

from browser_agent.errors import BrowserAgentError, normalize_error, redact


class ErrorTests(unittest.TestCase):
    def test_redacts_and_normalizes(self) -> None:
        self.assertEqual(
            redact("secret /private", ["", "secret"], ["", "/private"]),
            "<redacted> <internal>",
        )
        existing = BrowserAgentError(
            "CANCELLED", "cancelled", details={"attempt": 1}, cause="cause"
        )
        self.assertIs(normalize_error(existing, "PROCESS_EXITED", [], []), existing)
        normalized = normalize_error(
            RuntimeError("secret"), "PROCESS_EXITED", ["secret"], []
        )
        self.assertEqual(str(normalized), "<redacted>")
        self.assertIsInstance(normalized.cause, RuntimeError)
        with self.assertRaises(FrozenInstanceError):
            existing.message = "changed"  # type: ignore[misc]
