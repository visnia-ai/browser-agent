from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

from browser_agent import BrowserAgentError
from browser_agent import BrowserAgentCredential, BrowserAgentTask
from browser_agent.options import child_environment, normalize_tasks, positive, reasoning, resolve_options


def valid(**overrides: object):
    values = {
        "provider": "openai",
        "model": "gpt-5.4",
        "download_directory": "downloads",
        "reasoning_effort": None,
        "api_key": "key",
        "endpoint_url": None,
        "openrouter_provider": None,
        "max_model_len": 48_000,
        "reserve_output_tokens": 4_000,
        "headless": False,
        "executable_path": None,
        "workspace_directory": None,
        "browser_profile_directory": None,
        "user_takeover_tool": False,
        "max_steps": 50,
        "concurrency": 8,
        "runs_per_task": 1,
        "retry_count": 2,
        "on_log": None,
        **overrides,
    }
    return resolve_options(**values)  # type: ignore[arg-type]


class OptionTests(unittest.TestCase):
    def test_resolves_paths_urls_defaults_and_environment_key(self) -> None:
        options = valid(
            model=" gpt-5.4 ",
            endpoint_url="https://example.com/v1",
            executable_path="./chrome",
            workspace_directory="./workspace",
            browser_profile_directory="./browser-profile",
            retry_count=0,
        )
        self.assertEqual(options.model, "gpt-5.4")
        self.assertEqual(options.executable_path, str(Path("chrome").resolve()))
        self.assertEqual(options.workspace_directory, str(Path("workspace").resolve()))
        self.assertEqual(
            options.browser_profile_directory,
            str(Path("browser-profile").resolve()),
        )
        self.assertEqual(options.retry_count, 0)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "inherited"}):
            self.assertEqual(valid(api_key=" ").api_key, "inherited")
        self.assertIsNone(
            valid(
                provider="vllm",
                model="qwen",
                api_key=None,
                endpoint_url="http://localhost:8000",
            ).api_key
        )
        with patch.dict(
            os.environ, {"OPENROUTER_API_KEY": "openrouter-environment-key"}
        ):
            openrouter = valid(
                provider="openrouter",
                model="vendor/new-model",
                reasoning_effort="xhigh",
                api_key=" ",
                openrouter_provider=" baseten/fp8 ",
            )
            self.assertEqual(openrouter.api_key, "openrouter-environment-key")
            self.assertEqual(openrouter.openrouter_provider, "baseten/fp8")
            environment = child_environment(openrouter)
            self.assertEqual(
                environment["OPENROUTER_API_KEY"], "openrouter-environment-key"
            )
            self.assertNotIn("OPENAI_API_KEY", environment)

    def test_rejects_invalid_options(self) -> None:
        cases = [
            {"provider": "unknown"},
            {"model": ""},
            {"model": 1},
            {"download_directory": ""},
            {"download_directory": 1},
            {"endpoint_url": "bad"},
            {"endpoint_url": "ftp://example.com"},
            {"provider": "vllm", "model": "qwen", "endpoint_url": None},
            {
                "provider": "openrouter",
                "model": "vendor/model",
                "reasoning_effort": None,
            },
            {
                "provider": "openrouter",
                "model": "vendor/model",
                "reasoning_effort": "max",
            },
            {
                "provider": "openrouter",
                "model": "vendor/model",
                "reasoning_effort": "enabled",
            },
            {"openrouter_provider": "baseten"},
            {
                "provider": "openrouter",
                "model": "vendor/model",
                "reasoning_effort": "high",
                "openrouter_provider": " ",
            },
            {"api_key": ""},
            {"retry_count": -1},
            {"retry_count": 1.5},
            {"retry_count": False},
            {"max_model_len": 0},
            {"reserve_output_tokens": 0},
            {"max_model_len": 4_000, "reserve_output_tokens": 4_000},
        ]
        with patch.dict(os.environ, {}, clear=True):
            for overrides in cases:
                with (
                    self.subTest(overrides=overrides),
                    self.assertRaises(BrowserAgentError),
                ):
                    valid(**overrides)

    def test_reasoning_limits_tasks_paths_and_environment(self) -> None:
        self.assertEqual(reasoning("openai", "gpt-5.4", None), "low")
        for model in ("gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"):
            self.assertEqual(reasoning("openai", model, None), "low")
            for effort in ("xhigh", "max"):
                self.assertEqual(reasoning("openai", model, effort), effort)
        self.assertEqual(reasoning("together", "zai-org/GLM-5.2", None), "high")
        self.assertEqual(reasoning("vllm", "my-QWEN", None), "enabled")
        self.assertEqual(
            reasoning("vllm", "nvidia/GLM-5.2-NVFP4", None), "high"
        )
        self.assertEqual(
            reasoning(
                "vllm", "deepseek-ai/DeepSeek-V4-Flash-0731", None
            ),
            "high",
        )
        self.assertEqual(
            reasoning(
                "vllm", "deepseek-ai/DeepSeek-V4-Flash-0731", "max"
            ),
            "max",
        )
        self.assertEqual(reasoning("anthropic", "custom", "none"), "none")
        self.assertEqual(reasoning("openrouter", "vendor/model", "xhigh"), "xhigh")
        for provider, model, effort in [
            ("openai", "unknown", None),
            ("openai", "gpt-5.2-codex", None),
            ("openai", "gpt-5.4-nano", None),
            ("together", "moonshotai/Kimi-K2.6", None),
            ("vllm", "MiniMaxAI/MiniMax-M2.5", None),
            ("openai", "gpt-5.4", "max"),
            ("anthropic", "custom", None),
        ]:
            with self.assertRaises(BrowserAgentError):
                reasoning(provider, model, effort)  # type: ignore[arg-type]
        self.assertEqual(positive(None, 4), 4)  # type: ignore[arg-type]
        for value in (0, False, 1.5):
            with self.assertRaises(BrowserAgentError):
                positive(value, 4)  # type: ignore[arg-type]
        self.assertEqual(
            normalize_tasks(BrowserAgentTask(
                " go ", " https://x.test ",
                [BrowserAgentCredential(" user ", " password ", " example.com ")],
            )),
            [BrowserAgentTask(
                "go", "https://x.test",
                (BrowserAgentCredential("user", " password ", "example.com"),),
            )],
        )
        invalid_credentials = [
            "bad",
            [None],
            [BrowserAgentCredential("", "x", "x")],
            [BrowserAgentCredential("x", "", "x")],
            [BrowserAgentCredential("x", "x", "")],
        ]
        for tasks in ([], [None], [BrowserAgentTask("")], [BrowserAgentTask("ok", "")]):
            with self.assertRaises(BrowserAgentError):
                normalize_tasks(tasks)  # type: ignore[arg-type]
        for credentials in invalid_credentials:
            with self.assertRaises(BrowserAgentError):
                normalize_tasks(BrowserAgentTask(
                    "ok", credentials=credentials  # type: ignore[arg-type]
                ))
        with patch.dict(
            os.environ,
            {"OPENAI_API_KEY": "old", "ANTHROPIC_API_KEY": "remove"},
            clear=False,
        ):
            environment = child_environment(valid(api_key="new"))
            self.assertEqual(environment["OPENAI_API_KEY"], "new")
            self.assertNotIn("ANTHROPIC_API_KEY", environment)
