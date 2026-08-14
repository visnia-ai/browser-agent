from __future__ import annotations

import asyncio
import inspect
import json
import tempfile
import unittest
from pathlib import Path
from types import MappingProxyType

import browser_agent
from browser_agent import (
    BrowserAgent, BrowserAgentCustomTool, BrowserAgentError, BrowserAgentTask,
)
from browser_agent.runtime import ExecutableDependencies
from tests.helpers import create_agent, fake_environment


class AgentTests(unittest.TestCase):
    def test_package_root_api_and_frozen_models(self) -> None:
        self.assertEqual(set(browser_agent.__all__), {
            "BrowserAgent", "BrowserAgentCredential", "BrowserAgentCustomTool",
            "BrowserAgentError", "BrowserAgentErrorCode",
            "BrowserAgentEvent", "BrowserAgentLogEntry", "BrowserAgentResult",
            "BrowserAgentRun", "BrowserAgentTask", "BrowserAgentTaskResult",
            "BrowserAgentTaskRunResult", "BrowserAgentValidatorResult", "ErrorEvent",
            "Provider", "ReasoningEffort", "RunCompletedEvent", "RunStartedEvent",
            "TaskResultEvent", "UserTakeoverCategory", "UserTakeoverEvent",
            "ValidatorLifecycleMode", "check_codex_login", "ensure_codex_login",
        })
        parameters = inspect.signature(BrowserAgent).parameters
        self.assertEqual(list(parameters), [
            "provider", "model", "download_directory", "reasoning_effort", "api_key",
            "endpoint_url", "openrouter_provider", "max_model_len",
            "reserve_output_tokens", "headless", "executable_path",
            "workspace_directory", "browser_profile_directory",
            "user_takeover_tool", "custom_tools", "max_steps", "concurrency", "runs_per_task",
            "retry_count", "validator_lifecycle", "on_log",
        ])
        self.assertTrue(all(item.kind is inspect.Parameter.KEYWORD_ONLY
                            for item in parameters.values()))
        self.assertNotIn("timeout_ms", inspect.signature(BrowserAgent.run).parameters)
        self.assertEqual(parameters["custom_tools"].default, ())

    def test_normalizes_custom_tools(self) -> None:
        schema = {
            "type": "object",
            "properties": {"selector": {"type": "string", "minLength": 1}},
            "required": ["selector"],
            "additionalProperties": False,
        }
        agent = create_agent(custom_tools=[BrowserAgentCustomTool(
            "read_heading", " Read a heading. ", MappingProxyType(schema),
            " async ({ args, cdp }) => cdp.send('Runtime.evaluate', { expression: args.selector }) ",
        )])
        self.assertEqual(agent._custom_tools, (BrowserAgentCustomTool(
            "read_heading", "Read a heading.", schema,
            "async ({ args, cdp }) => cdp.send('Runtime.evaluate', { expression: args.selector })",
        ),))
        self.assertIsNot(agent._custom_tools[0].arguments, schema)

    def test_rejects_invalid_custom_tools(self) -> None:
        circular: dict[str, object] = {"type": "object"}
        circular["self"] = circular
        definitions = [
            "bad",
            [None],
            [BrowserAgentCustomTool("Bad-Name", "description", {"type": "object"}, "() => null")],
            [BrowserAgentCustomTool("click", "description", {"type": "object"}, "() => null")],
            [
                BrowserAgentCustomTool("duplicate", "first", {"type": "object"}, "() => null"),
                BrowserAgentCustomTool("duplicate", "second", {"type": "object"}, "() => null"),
            ],
            [BrowserAgentCustomTool("empty_description", " ", {"type": "object"}, "() => null")],
            [BrowserAgentCustomTool("array_arguments", "description", {"type": "array"}, "() => null")],
            [BrowserAgentCustomTool("empty_javascript", "description", {"type": "object"}, " ")],
            [BrowserAgentCustomTool("circular_schema", "description", circular, "() => null")],
            [BrowserAgentCustomTool("non_json", "description", {"type": "object", "minimum": float("nan")}, "() => null")],
            [BrowserAgentCustomTool("bad_key", "description", {"type": "object", 1: True}, "() => null")],
            [BrowserAgentCustomTool("bad_value", "description", {"type": "object", "example": {1}}, "() => null")],
        ]
        for custom_tools in definitions:
            with self.subTest(custom_tools=custom_tools), self.assertRaises(BrowserAgentError):
                create_agent(custom_tools=custom_tools)
    def test_validates_construction_and_active_loop(self) -> None:
        with self.assertRaises(BrowserAgentError):
            BrowserAgent(
                provider="unknown",  # type: ignore[arg-type]
                model="model",
                download_directory=".",
            )
        with self.assertRaises(BrowserAgentError) as caught:
            create_agent().run(BrowserAgentTask("outside"))
        self.assertEqual(caught.exception.code, "PROCESS_START_FAILED")

        async def invalid_runs() -> None:
            agent = create_agent()
            with self.assertRaises(BrowserAgentError):
                agent.run([])

        asyncio.run(invalid_runs())


class AgentIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_replay_defaults_cleanup_and_verification_cache(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-sdk-test-") as directory:
            capture = str(Path(directory) / "capture.json")
            versions = str(Path(directory) / "versions.txt")
            logs: list[str] = []
            with fake_environment(
                "success",
                SDK_FAKE_CAPTURE=capture,
                SDK_FAKE_VERSION_COUNT=versions,
            ):
                agent = create_agent(logs)
                from browser_agent import BrowserAgentCredential
                run = agent.run([
                    BrowserAgentTask(
                        "first",
                        credentials=[BrowserAgentCredential(
                            "sdk-user@example.com", "sdk-password", "login.example.com"
                        ), BrowserAgentCredential(
                            "backup-user@example.com", "backup-password",
                            "backup.example.com",
                        )],
                    ),
                    BrowserAgentTask("fail second"),
                ])
                result = await run.result
                self.assertEqual(result.status, "failed")
                self.assertEqual(
                    [task.task_id for task in result.tasks], ["task-1", "task-2"]
                )
                first = [event async for event in run.events()]
                replayed = [event async for event in run.events()]
                self.assertEqual(first, replayed)
                self.assertEqual(first[0].type, "run_started")
                self.assertEqual(first[-1].type, "run_completed")

                captured = json.loads(Path(capture).read_text())
                config = captured["config"]
                self.assertEqual(
                    config["stage_llms"]["runAgent"]["reasoning_effort"],
                    "low",
                )
                self.assertEqual(config["headless"], False)
                self.assertNotIn("sdk-secret", json.dumps(config))
                self.assertNotIn("sdk-password", json.dumps(config))
                self.assertEqual(captured["requestCredentialCounts"], [2, 0])
                self.assertEqual(
                    captured["environment"], {"OPENAI_API_KEY": "sdk-secret"}
                )
                self.assertFalse(Path(config["file_workspace_root"]).exists())
                self.assertTrue(any("<redacted>" in line for line in logs))
                self.assertTrue(any("<internal>" in line for line in logs))
                self.assertFalse(any("sdk-password" in line for line in logs))
                self.assertFalse(any("backup-password" in line for line in logs))
                self.assertNotIn("sdk-password", repr(result))
                self.assertNotIn("backup-password", repr(result))
                self.assertTrue(all(
                    "<redacted>" in error for error in result.tasks[0].errors
                ))

                await agent.run(BrowserAgentTask("again")).result
                self.assertEqual(len(Path(versions).read_text().splitlines()), 1)

    async def test_caches_rejected_verification(self) -> None:
        resolutions = 0

        async def resolve() -> str:
            nonlocal resolutions
            resolutions += 1
            return "missing"

        async def reject(_: str) -> None:
            raise BrowserAgentError("CLI_NOT_FOUND", "missing")

        agent = create_agent()
        agent._dependencies = ExecutableDependencies(resolve, reject)
        for task in ("one", "two"):
            with self.assertRaises(BrowserAgentError):
                await agent.run(BrowserAgentTask(task)).result
        self.assertEqual(resolutions, 1)
