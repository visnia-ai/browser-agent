from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from browser_agent import BrowserAgentTask
from browser_agent.runtime import (
    cached_executable,
    cli_manifest,
    create_runtime_files,
    platform_key,
    resolve_executable,
    verify_executable,
)
from tests.helpers import FAKE_EXECUTABLE, fake_environment
from tests.test_options import valid


class ConfigTests(unittest.TestCase):
    def test_creates_private_files_and_preserves_owned_directories(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-config-") as root:
            workspace = str(Path(root) / "workspace")
            downloads = str(Path(root) / "downloads")
            files = create_runtime_files(
                valid(
                    download_directory=downloads,
                    workspace_directory=workspace,
                    executable_path="./chrome",
                    endpoint_url="https://example.com/v1",
                ),
                [BrowserAgentTask("go", "https://example.com")],
            )
            runtime_directory = str(Path(files.config_path).parent)
            self.assertEqual(os.stat(runtime_directory).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(files.config_path).st_mode & 0o777, 0o600)
            config = json.loads(Path(files.config_path).read_text())
            self.assertEqual(
                config["stage_llms"]["runAgent"]["endpoint_url"],
                "https://example.com/v1",
            )
            self.assertEqual(config["executable_path"], str(Path("chrome").resolve()))
            self.assertEqual(
                config["validator_lifecycle"],
                {"mode": "retry", "max_failures": 3, "context": "full"},
            )
            files.cleanup()
            files.cleanup()
            self.assertFalse(Path(runtime_directory).exists())
            self.assertTrue(Path(workspace).exists())
            self.assertTrue(Path(downloads).exists())

    def test_forwards_openrouter_provider_constraint(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-openrouter-config-") as root:
            files = create_runtime_files(
                valid(
                    provider="openrouter",
                    model="z-ai/glm-5.2",
                    reasoning_effort="xhigh",
                    api_key="secret",
                    openrouter_provider="baseten/fp8",
                    download_directory=str(Path(root) / "downloads"),
                ),
                [BrowserAgentTask("go")],
            )
            config = json.loads(Path(files.config_path).read_text())
            self.assertEqual(
                config["stage_llms"]["runAgent"]["openrouter_provider"],
                "baseten/fp8",
            )
            files.cleanup()

    def test_generates_glm52_benchmark_baseline_profile(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-glm52-config-") as root:
            files = create_runtime_files(
                valid(
                    provider="vllm",
                    model="nvidia/GLM-5.2-NVFP4",
                    reasoning_effort="high",
                    api_key=None,
                    endpoint_url="http://38.147.81.21:8001/v1",
                    max_model_len=48_000,
                    reserve_output_tokens=4_000,
                    browser_profile_directory=(
                        "/Users/example/Documents/browser-agent/chrome_workspace"
                    ),
                    download_directory=str(Path(root) / "downloads"),
                ),
                [BrowserAgentTask("go")],
            )
            config = json.loads(Path(files.config_path).read_text())
            self.assertEqual(
                config["stage_llms"]["findTargetURL"]["reasoning_effort"],
                "none",
            )
            expected_stage = {
                "provider": "vllm",
                "model": "nvidia/GLM-5.2-NVFP4",
                "reasoning_effort": "high",
                "max_model_len": 48_000,
                "reserve_output_tokens": 4_000,
                "endpoint_url": "http://38.147.81.21:8001/v1",
            }
            for stage in (
                "createChecklist",
                "runAgent", "verifySuccess",
                "dataExtraction",
            ):
                self.assertEqual(config["stage_llms"][stage], expected_stage)
            self.assertEqual(config["feature_flags"], {
                "workflow_orchestration": False,
                "task_checklist": True,
                "pre_step_screenshot_in_latest_user_prompt": False,
                "user_takeover_tool": False,
                "auth_takeover": True,
                "agent_takeover_tool": False,
                "extract_data_whole_context": True,
                "semantic_projection_history": "current",
                "optimize_executor_step_delays": False,
                "optimize_text_input": False,
            })
            self.assertEqual(config["concurrency"], 8)
            self.assertEqual(config["browser_profiles"], {
                "mode": "seeded",
                "seed_user_data_dir": (
                    "/Users/example/Documents/browser-agent/chrome_workspace"
                ),
                "per_worker_user_data_root": str(
                    Path(files.config_path).parent / "browser-profiles"
                ),
                "reuse_existing_worker_profiles": False,
            })
            self.assertTrue(config["save_task_logs"])
            self.assertEqual(
                config["validator_lifecycle"],
                {"mode": "retry", "max_failures": 3, "context": "full"},
            )
            files.cleanup()

    def test_automatic_workspace_and_partial_failure_cleanup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-config-failures-") as root:
            options = valid(download_directory=str(Path(root) / "downloads"))
            with patch("browser_agent.runtime.os.getcwd", return_value=root):
                files = create_runtime_files(options, [BrowserAgentTask("go")])
                workspace = files.internal_paths[-1]
                self.assertIn(workspace, files.internal_paths)
                files.cleanup()
                self.assertFalse(Path(workspace).exists())

                with (
                    patch(
                        "browser_agent.runtime.Path.mkdir",
                        side_effect=OSError("failed"),
                    ),
                    patch("browser_agent.runtime.shutil.rmtree") as remove,
                    self.assertRaises(OSError),
                ):
                    create_runtime_files(options, [BrowserAgentTask("go")])
                self.assertGreaterEqual(remove.call_count, 2)

                with (
                    patch(
                        "browser_agent.runtime.os.chmod",
                        side_effect=OSError("failed"),
                    ),
                    patch("browser_agent.runtime.shutil.rmtree") as remove_runtime,
                    self.assertRaises(OSError),
                ):
                    create_runtime_files(options, [BrowserAgentTask("go")])
                remove_runtime.assert_called_once()

                with (
                    patch(
                        "browser_agent.runtime.tempfile.mkdtemp",
                        side_effect=OSError("failed"),
                    ),
                    patch("browser_agent.runtime.shutil.rmtree") as remove_nothing,
                    self.assertRaises(OSError),
                ):
                    create_runtime_files(options, [BrowserAgentTask("go")])
                remove_nothing.assert_not_called()

    def test_normalizes_platforms_and_architectures(self) -> None:
        for system, machine, expected in [
            ("darwin", "aarch64", "darwin-arm64"),
            ("linux", "AMD64", "linux-x64"),
            ("win32", "x86_64", "win32-x64"),
            ("other", "custom", "other-custom"),
        ]:
            self.assertEqual(platform_key(system, machine), expected)
        self.assertTrue(
            str(cached_executable("1.2.3", "win32", "amd64", Path("/cache")))
            .endswith("1.2.3/win32-x64/browser-agent.exe")
        )


class ExecutableTests(unittest.IsolatedAsyncioTestCase):
    async def test_resolves_and_verifies_executable_outcomes(self) -> None:
        self.assertTrue(str(cli_manifest()).endswith("cli-manifest.json"))
        self.assertEqual(
            await resolve_executable(Path(FAKE_EXECUTABLE)),
            FAKE_EXECUTABLE,
        )
        with fake_environment(
            "success", BROWSER_AGENT_CLI_PATH=FAKE_EXECUTABLE
        ):
            self.assertEqual(await resolve_executable(), FAKE_EXECUTABLE)
        with self.assertRaisesRegex(Exception, "unavailable"):
            await resolve_executable(Path("/definitely/missing"))
        with fake_environment("success"):
            await verify_executable(FAKE_EXECUTABLE)
        with fake_environment("version-mismatch"):
            with self.assertRaisesRegex(Exception, "incompatible"):
                await verify_executable(FAKE_EXECUTABLE)
        with self.assertRaisesRegex(Exception, "could not be started"):
            await verify_executable("/definitely/missing")
        with tempfile.TemporaryDirectory(prefix="py-executable-") as directory:
            malformed = Path(directory) / "malformed"
            malformed.write_text("#!/bin/sh\nprintf 'bad json'\n")
            malformed.chmod(0o700)
            with self.assertRaisesRegex(Exception, "incompatible"):
                await verify_executable(str(malformed))
            sleeper = Path(directory) / "sleeper"
            sleeper.write_text("#!/bin/sh\nsleep 1\n")
            sleeper.chmod(0o700)
            with self.assertRaisesRegex(Exception, "timed out"):
                await verify_executable(str(sleeper), 0.005)

    async def test_downloads_verifies_caches_and_reuses_executable(self) -> None:
        payload = b"#!/bin/sh\nexit 0\n"
        checksum = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory(prefix="py-cli-download-") as directory:
            root = Path(directory)
            manifest = root / "cli-manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": "1.2.3",
                        "platforms": {
                            "linux-x64": {
                                "url": "https://github.com/visnia-ai/browser-agent/releases/download/test/browser-agent-linux-x64",
                                "sha256": checksum,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            cache = root / "cache"
            with patch(
                "browser_agent.runtime.urllib.request.urlopen",
                return_value=io.BytesIO(payload),
            ) as download:
                executable = await resolve_executable(
                    manifest=manifest,
                    cache_directory=cache,
                    system="linux",
                    machine="x86_64",
                )
                reused = await resolve_executable(
                    manifest=manifest,
                    cache_directory=cache,
                    system="linux",
                    machine="x86_64",
                )
            self.assertEqual(executable, reused)
            self.assertEqual(Path(executable).read_bytes(), payload)
            self.assertNotEqual(os.stat(executable).st_mode & 0o111, 0)
            download.assert_called_once()

    async def test_rejects_download_and_manifest_failures(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-cli-failure-") as directory:
            root = Path(directory)
            manifest = root / "cli-manifest.json"
            target = {
                "url": "https://github.com/visnia-ai/browser-agent/releases/download/test/browser-agent-linux-x64",
                "sha256": "0" * 64,
            }
            manifest.write_text(
                json.dumps(
                    {"version": "1.2.3", "platforms": {"linux-x64": target}}
                ),
                encoding="utf-8",
            )
            with patch(
                "browser_agent.runtime.urllib.request.urlopen",
                return_value=io.BytesIO(b"wrong"),
            ), self.assertRaisesRegex(Exception, "checksum verification failed"):
                await resolve_executable(
                    manifest=manifest,
                    cache_directory=root / "checksum-cache",
                    system="linux",
                    machine="x86_64",
                )
            with patch(
                "browser_agent.runtime.urllib.request.urlopen",
                side_effect=urllib.error.URLError("offline"),
            ), self.assertRaisesRegex(Exception, "Unable to download"):
                await resolve_executable(
                    manifest=manifest,
                    cache_directory=root / "offline-cache",
                    system="linux",
                    machine="x86_64",
                )
            with self.assertRaisesRegex(Exception, "metadata is unavailable"):
                await resolve_executable(
                    manifest=manifest,
                    cache_directory=root / "unsupported-cache",
                    system="darwin",
                    machine="arm64",
                )
