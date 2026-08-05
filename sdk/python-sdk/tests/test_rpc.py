from __future__ import annotations

import unittest

from browser_agent import BrowserAgentError
from browser_agent.rpc import RpcState

VALID = {
    "task_id": "task-2",
    "status": "completed",
    "runs": [
        {
            "run_index": 1,
            "completed": True,
            "data": 0,
            "validator": {"ran": False, "success": True, "summary": "ok"},
        }
    ],
    "errors": ["one", 2],
}


class ResultTests(unittest.TestCase):
    def consume(self, *messages):
        events, failure = [], None
        rpc = RpcState("run", ["secret"], ["/private"])
        completed = False
        try:
            for message in messages:
                event = rpc.handle(message)
                if event == "complete":
                    completed = True
                elif event:
                    events.append(event)
        except BaseException as error:
            failure = error
        return events, completed, failure, rpc

    def test_normalizes_results_and_rpc_events(self) -> None:
        events, completed, failure, rpc = self.consume(
            {"jsonrpc": "2.0", "id": 1, "result": {"accepted": True}},
            {"jsonrpc": "2.0", "method": "ignored"},
            {"jsonrpc": "2.0", "method": "browser-agent/status", "params": None},
            {"jsonrpc": "2.0", "method": "browser-agent/status",
             "params": {"category": "payment"}},
            {"jsonrpc": "2.0", "method": "browser-agent/task_result", "params": VALID},
            {"jsonrpc": "2.0", "method": "browser-agent/task_result",
             "params": {**VALID, "task_id": "custom", "errors": None}},
            {"jsonrpc": "2.0", "method": "browser-agent/all_tasks_completed"},
        )
        self.assertTrue(completed)
        self.assertIsNone(failure)
        self.assertEqual([event.type for event in events], [
            "run_started", "user_takeover", "user_takeover", "task_result", "task_result"
        ])
        self.assertEqual([item.task_id for item in rpc.results], ["task-2", "custom"])
        result = rpc.results[0]
        self.assertEqual(result.runs[0].data, 0)
        self.assertEqual(result.errors, ("one",))

    def test_rejects_invalid_result_shapes(self) -> None:
        cases = [
            None,
            [],
            {},
            {**VALID, "task_id": 1},
            {**VALID, "status": "pending"},
            {**VALID, "runs": None},
            {**VALID, "runs": [None]},
            {**VALID, "runs": [{"validator": None}]},
            {
                **VALID,
                "runs": [
                    {
                        "run_index": "1",
                        "completed": True,
                        "validator": {"ran": True, "success": True, "summary": ""},
                    }
                ],
            },
        ]
        for value in cases:
            _, _, failure, _ = self.consume(
                {"jsonrpc": "2.0", "method": "browser-agent/task_result", "params": value}
            )
            self.assertIsInstance(failure, BrowserAgentError)

    def test_maps_rejections_and_errors(self) -> None:
        for code, expected in [
            ("CONFIG_INVALID", "CONFIG_INVALID"),
            ("CHROME_NOT_FOUND", "CHROME_NOT_FOUND"),
            ("UNKNOWN", "PROTOCOL_ERROR"),
            (None, "PROTOCOL_ERROR"),
        ]:
            _, _, failure, _ = self.consume({
                "jsonrpc": "2.0", "id": 1,
                "error": {"message": "secret /private",
                          "data": {"code": code} if code else None},
            })
            self.assertEqual(failure.code, expected)
            self.assertEqual(str(failure), "<redacted> <internal>")
        for message, expected in [
            ({"jsonrpc": "2.0", "id": 1, "result": {}}, "did not accept"),
            ({"jsonrpc": "2.0", "method": "browser-agent/error", "params": None},
             "browser-agent failed"),
        ]:
            _, _, failure, _ = self.consume(message)
            self.assertIn(expected, str(failure))
