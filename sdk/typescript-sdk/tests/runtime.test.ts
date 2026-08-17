import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOptions } from "../src/options.js";
import {
	bundledExecutable,
	createRuntimeFiles,
	platformKey,
	resolveExecutable,
	verifyExecutable,
} from "../src/runtime.js";
import { fakeExecutable, withMode } from "./helpers.js";

test("creates private files and preserves caller-owned directories", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-config-"));
	const workspace = path.join(root, "workspace");
	const downloads = path.join(root, "downloads");
	try {
		const files = await createRuntimeFiles(
			resolveOptions({
				provider: "openai",
				model: "gpt-5.4",
				apiKey: "secret",
				downloadDirectory: downloads,
				workspaceDirectory: workspace,
				executablePath: "./chrome",
				endpointUrl: "https://example.com/v1",
			}),
			[{ task: "go", url: "https://example.com" }],
		);
		const runtimeDirectory = path.dirname(files.configPath);
		assert.equal(fs.statSync(runtimeDirectory).mode & 0o777, 0o700);
		assert.equal(fs.statSync(files.configPath).mode & 0o777, 0o600);
		const config = JSON.parse(fs.readFileSync(files.configPath, "utf8"));
		assert.equal(config.executable_path, path.resolve("chrome"));
		assert.equal(
			config.stage_llms.runAgent.endpoint_url,
			"https://example.com/v1",
		);
		assert.deepEqual(config.validator_lifecycle, {
			mode: "retry",
			max_failures: 3,
			context: "full",
		});
		await files.cleanup();
		assert.equal(fs.existsSync(runtimeDirectory), false);
		assert.equal(fs.existsSync(workspace), true);
		assert.equal(fs.existsSync(downloads), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("forwards the OpenRouter provider constraint", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-openrouter-config-"));
	try {
		const files = await createRuntimeFiles(
			resolveOptions({
				provider: "openrouter",
				model: "z-ai/glm-5.2",
				reasoningEffort: "xhigh",
				apiKey: "secret",
				openrouterProvider: "baseten/fp8",
				downloadDirectory: path.join(root, "downloads"),
			}),
			[{ task: "go" }],
		);
		const config = JSON.parse(fs.readFileSync(files.configPath, "utf8"));
		assert.equal(config.stage_llms.runAgent.openrouter_provider, "baseten/fp8");
		await files.cleanup();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("disables validator lifecycle when requested", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-validator-config-"));
	try {
		const files = await createRuntimeFiles(
			resolveOptions({
				provider: "openai",
				model: "gpt-5.4",
				apiKey: "secret",
				downloadDirectory: path.join(root, "downloads"),
				validatorLifecycle: "disabled",
			}),
			[{ task: "go" }],
		);
		const config = JSON.parse(fs.readFileSync(files.configPath, "utf8"));
		assert.deepEqual(config.validator_lifecycle, {
			mode: "disabled",
			max_failures: 3,
			context: "full",
		});
		await files.cleanup();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("forwards Codex without credential or endpoint overrides", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-codex-config-"));
	try {
		const files = await createRuntimeFiles(
			resolveOptions({
				provider: "codex",
				model: "gpt-5.6-luna",
				downloadDirectory: path.join(root, "downloads"),
			}),
			[{ task: "go" }],
		);
		const config = JSON.parse(fs.readFileSync(files.configPath, "utf8"));
		assert.equal(config.stage_llms.runAgent.provider, "codex");
		assert.equal(config.stage_llms.runAgent.endpoint_url, undefined);
		await files.cleanup();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("generates the GLM 5.2 benchmark baseline profile", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-glm52-config-"));
	try {
		const files = await createRuntimeFiles(
			resolveOptions({
				provider: "vllm",
				model: "nvidia/GLM-5.2-NVFP4",
				reasoningEffort: "high",
				endpointUrl: "http://38.147.81.21:8001/v1",
				maxModelLen: 48_000,
				reserveOutputTokens: 4_000,
				browserProfileDirectory:
					"/Users/example/Documents/browser-agent/chrome_workspace",
				downloadDirectory: path.join(root, "downloads"),
			}),
			[{ task: "go" }],
		);
		const config = JSON.parse(fs.readFileSync(files.configPath, "utf8"));
		assert.equal(config.stage_llms.findTargetURL.reasoning_effort, "none");
		for (const stage of [
			"createChecklist",
			"runAgent",
			"verifySuccess",
			"dataExtraction",
		]) {
			assert.deepEqual(config.stage_llms[stage], {
				provider: "vllm",
				model: "nvidia/GLM-5.2-NVFP4",
				reasoning_effort: "high",
				max_model_len: 48_000,
				reserve_output_tokens: 4_000,
				endpoint_url: "http://38.147.81.21:8001/v1",
			});
		}
		assert.deepEqual(config.feature_flags, {
			workflow_orchestration: false,
			pre_step_screenshot_in_latest_user_prompt: false,
			user_takeover_tool: false,
			auth_takeover: true,
			agent_takeover_tool: false,
			extract_data_whole_context: true,
			semantic_projection_history: "current",
			optimize_executor_step_delays: false,
			optimize_text_input: false,
		});
		assert.deepEqual(config.validator_lifecycle, {
			mode: "retry",
			max_failures: 3,
			context: "full",
		});
		assert.equal(config.concurrency, 8);
		assert.deepEqual(config.browser_profiles, {
			mode: "seeded",
			seed_user_data_dir:
				"/Users/example/Documents/browser-agent/chrome_workspace",
			per_worker_user_data_root: path.join(
				path.dirname(files.configPath),
				"browser-profiles",
			),
			reuse_existing_worker_profiles: false,
		});
		assert.equal(config.save_task_logs, true);
		await files.cleanup();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("normalizes platforms and resolves executable bundles", async () => {
	assert.equal(platformKey(), `${process.platform}-${process.arch}`);
	assert.equal(bundledExecutable("aix", "ppc64"), "");
	assert.match(bundledExecutable("win32", "x64"), /\/bin\/browser-agent\.exe$/);
	assert.match(bundledExecutable("linux", "arm64"), /\/bin\/browser-agent$/);
	const executable = path.join(os.tmpdir(), `sdk-executable-${Date.now()}`);
	fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
	try {
		assert.equal(await resolveExecutable(executable), executable);
	} finally {
		fs.rmSync(executable, { force: true });
	}
	await assert.rejects(resolveExecutable("/definitely/missing"), {
		code: "CLI_NOT_FOUND",
	});
	const absentPlatform = process.platform === "win32" ? "darwin" : "win32";
	await assert.rejects(resolveExecutable(undefined, absentPlatform, "x64"), {
		code: "CLI_NOT_FOUND",
		message: /lifecycle scripts/,
	});
	await assert.rejects(resolveExecutable(undefined, "aix", "ppc64"), {
		code: "CLI_NOT_FOUND",
		message: /does not provide/,
	});
});

test("verifies compatible, incompatible, missing, and timed-out executables", async () => {
	await withMode("success", () => verifyExecutable(fakeExecutable));
	await withMode("version-mismatch", async () => {
		await assert.rejects(verifyExecutable(fakeExecutable), {
			code: "CLI_VERSION_INCOMPATIBLE",
		});
	});
	await assert.rejects(
		verifyExecutable(path.join(os.tmpdir(), "missing-cli")),
		{
			code: "CLI_NOT_FOUND",
		},
	);
	const sleeper = path.join(os.tmpdir(), `sdk-sleeper-${Date.now()}`);
	const failing = path.join(os.tmpdir(), `sdk-failing-${Date.now()}`);
	fs.writeFileSync(sleeper, "#!/bin/sh\nsleep 1\n", { mode: 0o700 });
	fs.writeFileSync(failing, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	try {
		await assert.rejects(verifyExecutable(sleeper, 5), {
			code: "CLI_VERSION_INCOMPATIBLE",
		});
		await assert.rejects(verifyExecutable(failing), {
			code: "CLI_VERSION_INCOMPATIBLE",
		});
	} finally {
		fs.rmSync(sleeper, { force: true });
		fs.rmSync(failing, { force: true });
	}
});

test("cleans partial runtime files after setup failure", async () => {
	const before = new Set(
		fs
			.readdirSync(process.cwd())
			.filter((name) => name.startsWith(".browser-agent-workspace-")),
	);
	const file = path.join(os.tmpdir(), `ts-sdk-file-${Date.now()}`);
	fs.writeFileSync(file, "");
	try {
		await assert.rejects(
			createRuntimeFiles(
				resolveOptions({
					provider: "openai",
					model: "gpt-5.4",
					apiKey: "secret",
					downloadDirectory: file,
				}),
				[{ task: "go" }],
			),
		);
		const after = fs
			.readdirSync(process.cwd())
			.filter((name) => name.startsWith(".browser-agent-workspace-"));
		assert(after.every((name) => before.has(name)));
	} finally {
		fs.rmSync(file, { force: true });
	}
});
