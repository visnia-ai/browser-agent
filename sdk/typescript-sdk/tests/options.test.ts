import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
	childEnvironment,
	normalizeTasks,
	resolveOptions,
} from "../src/options.js";
import type { BrowserAgentOptions } from "../src/types.js";

const base: BrowserAgentOptions = {
	provider: "openai",
	model: "gpt-5.4",
	apiKey: "key",
	downloadDirectory: "downloads",
};

test("resolves provider capabilities, paths, environment, and overrides", () => {
	const options = resolveOptions({
		...base,
		model: " gpt-5.4 ",
		endpointUrl: "https://example.com/v1",
		executablePath: "./chrome",
		workspaceDirectory: "./workspace",
		browserProfileDirectory: "./browser-profile",
		headless: true,
		userTakeoverTool: false,
		maxSteps: 1,
		concurrency: 2,
		runsPerTask: 3,
		retryCount: 0,
	});
	assert.equal(options.reasoningEffort, "low");
	assert.equal(options.downloadDirectory, path.resolve("downloads"));
	assert.equal(options.workspaceDirectory, path.resolve("workspace"));
	assert.equal(
		options.browserProfileDirectory,
		path.resolve("browser-profile"),
	);
	assert.equal(options.executablePath, path.resolve("chrome"));
	assert.equal(options.headless, true);
	assert.equal(options.userTakeoverTool, false);
	assert.equal(options.retryCount, 0);
	assert.equal(options.maxModelLen, 48_000);
	assert.equal(options.reserveOutputTokens, 4_000);

	const previous = process.env.OPENAI_API_KEY;
	const anthropic = process.env.ANTHROPIC_API_KEY;
	process.env.OPENAI_API_KEY = "inherited";
	process.env.ANTHROPIC_API_KEY = "remove-me";
	try {
		const inherited = resolveOptions({ ...base, apiKey: " " });
		assert.equal(inherited.apiKey, "inherited");
		const environment = childEnvironment(inherited);
		assert.equal(environment.OPENAI_API_KEY, "inherited");
		assert.equal(environment.ANTHROPIC_API_KEY, undefined);
	} finally {
		if (previous === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous;
		if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = anthropic;
	}

	assert.equal(
		resolveOptions({
			...base,
			provider: "together",
			model: "zai-org/GLM-5.2",
		}).reasoningEffort,
		"high",
	);
	assert.equal(
		resolveOptions({
			...base,
			provider: "together",
			model: "deepseek-ai/DeepSeek-V4-Flash-0731",
			reasoningEffort: "low",
		}).reasoningEffort,
		"low",
	);
	assert.equal(
		resolveOptions({
			...base,
			provider: "vllm",
			model: "my-QWEN-model",
			apiKey: undefined,
			endpointUrl: "http://localhost:8000",
		}).reasoningEffort,
		"enabled",
	);
	assert.equal(
		resolveOptions({
			...base,
			provider: "vllm",
			model: "nvidia/GLM-5.2-NVFP4",
			apiKey: undefined,
			endpointUrl: "http://localhost:8001/v1",
		}).reasoningEffort,
		"high",
	);
	assert.equal(
		resolveOptions({
			...base,
			provider: "vllm",
			model: "deepseek-ai/DeepSeek-V4-Flash-0731",
			apiKey: undefined,
			endpointUrl: "http://38.147.81.21:8000/v1",
		}).reasoningEffort,
		"high",
	);
	assert.equal(
		resolveOptions({
			...base,
			provider: "vllm",
			model: "deepseek-ai/DeepSeek-V4-Flash-0731",
			reasoningEffort: "low",
			apiKey: undefined,
			endpointUrl: "http://38.147.81.21:8000/v1",
		}).reasoningEffort,
		"low",
	);
	assert.equal(
		resolveOptions({
			...base,
			provider: "anthropic",
			model: "custom",
			reasoningEffort: "none",
		}).reasoningEffort,
		"none",
	);
	assert.equal(
		resolveOptions({
			...base,
			provider: "openrouter",
			model: "vendor/new-model",
			reasoningEffort: "xhigh",
			openrouterProvider: " baseten/fp8 ",
		}).reasoningEffort,
		"xhigh",
	);
	assert.equal(
		resolveOptions({
			...base,
			provider: "openrouter",
			model: "vendor/new-model",
			reasoningEffort: "xhigh",
			openrouterProvider: " baseten/fp8 ",
		}).openrouterProvider,
		"baseten/fp8",
	);
	const previousOpenRouter = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "openrouter-environment-key";
	try {
		const openrouter = resolveOptions({
			...base,
			provider: "openrouter",
			model: "vendor/new-model",
			reasoningEffort: "medium",
			apiKey: " ",
		});
		assert.equal(openrouter.apiKey, "openrouter-environment-key");
		const environment = childEnvironment(openrouter);
		assert.equal(
			environment.OPENROUTER_API_KEY,
			"openrouter-environment-key",
		);
		assert.equal(environment.OPENAI_API_KEY, undefined);
	} finally {
		if (previousOpenRouter === undefined)
			delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousOpenRouter;
	}
	for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]) {
		assert.equal(resolveOptions({ ...base, model }).reasoningEffort, "low");
		for (const reasoningEffort of ["xhigh", "max"] as const) {
			assert.equal(
				resolveOptions({ ...base, model, reasoningEffort }).reasoningEffort,
				reasoningEffort,
			);
		}
	}
});

test("rejects every invalid option shape", () => {
	const invalid = [
		null,
		{ ...base, model: "" },
		{ ...base, downloadDirectory: "" },
		{ ...base, model: "unknown" },
		{ ...base, model: "gpt-5.2-codex" },
		{ ...base, model: "gpt-5.4-nano" },
		{
			...base,
			provider: "together",
			model: "moonshotai/Kimi-K2.6",
		},
		{
			...base,
			provider: "vllm",
			model: "MiniMaxAI/MiniMax-M2.5",
			endpointUrl: "http://localhost:8000",
		},
		{ ...base, reasoningEffort: "max" },
		{ ...base, endpointUrl: "ftp://example.com" },
		{ ...base, endpointUrl: "bad" },
		{ ...base, provider: "vllm", model: "qwen" },
		{
			...base,
			provider: "anthropic",
			model: "x",
			apiKey: "",
			reasoningEffort: "none",
		},
		{
			...base,
			provider: "anthropic",
			model: "x",
			apiKey: "key",
			reasoningEffort: undefined,
		},
		{
			...base,
			provider: "openrouter",
			model: "vendor/model",
			reasoningEffort: undefined,
		},
		{
			...base,
			provider: "openrouter",
			model: "vendor/model",
			reasoningEffort: "max",
		},
		{
			...base,
			provider: "openrouter",
			model: "vendor/model",
			reasoningEffort: "enabled",
		},
		{ ...base, openrouterProvider: "baseten" },
		{
			...base,
			provider: "openrouter",
			model: "vendor/model",
			reasoningEffort: "high",
			openrouterProvider: " ",
		},
		{ ...base, maxSteps: 0 },
		{ ...base, maxModelLen: 0 },
		{ ...base, reserveOutputTokens: 0 },
		{ ...base, maxModelLen: 4_000, reserveOutputTokens: 4_000 },
		{ ...base, concurrency: 1.5 },
		{ ...base, runsPerTask: Number.NaN },
		{ ...base, retryCount: -1 },
		{ ...base, retryCount: 1.5 },
	] as unknown[];
	for (const options of invalid) {
		assert.throws(() => resolveOptions(options as BrowserAgentOptions), {
			code: "CONFIG_INVALID",
		});
	}
});

test("normalizes tasks and rejects malformed tasks", () => {
	assert.deepEqual(
		normalizeTasks({
			task: " do ",
			url: " https://x.test ",
			credentials: [
				{
					username: " user ",
					password: " password ",
					domain: " example.com ",
				},
			],
		}),
		[
			{
				task: "do",
				url: "https://x.test",
				credentials: [
					{
						username: "user",
						password: " password ",
						domain: "example.com",
					},
				],
			},
		],
	);
	assert.deepEqual(normalizeTasks({ task: "do" }), [{ task: "do" }]);
	for (const input of [
		[],
		[null],
		[{ task: "" }],
		[{ task: "ok", url: "" }],
		[{ task: "ok", credentials: "bad" }],
		[{ task: "ok", credentials: [null] }],
		[
			{
				task: "ok",
				credentials: [{ username: "", password: "x", domain: "x" }],
			},
		],
		[
			{
				task: "ok",
				credentials: [{ username: "x", password: "", domain: "x" }],
			},
		],
		[
			{
				task: "ok",
				credentials: [{ username: "x", password: "x", domain: "" }],
			},
		],
	] as unknown[]) {
		assert.throws(() => normalizeTasks(input as never), {
			code: "CONFIG_INVALID",
		});
	}
});
