import dataclasses
import unittest

from browser_agent import BrowserAgentCredential, BrowserAgentTask


class ModelTests(unittest.TestCase):
    def test_dataclass_fields_are_frozen_and_slotted(self) -> None:
        self.assertEqual(
            [field.name for field in dataclasses.fields(BrowserAgentTask)],
            ["task", "url", "credentials"],
        )
        self.assertEqual(
            [field.name for field in dataclasses.fields(BrowserAgentCredential)],
            ["username", "password", "domain"],
        )
        task = BrowserAgentTask("task")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            task.task = "changed"  # type: ignore[misc]
        self.assertTrue(hasattr(BrowserAgentTask, "__slots__"))
