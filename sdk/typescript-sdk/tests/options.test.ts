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
	assert.equal(options.validatorLifecycle, "retry");
	assert.equal(options.maxModelLen, 48_000);
	assert.equal(options.reserveOutputTokens, 4_000);
	assert.equal(
		resolveOptions({ ...base, validatorLifecycle: "disabled" })
			.validatorLifecycle,
		"disabled",
	);

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
	const previousPath = process.env.PATH;
	const previousCodexHome = process.env.CODEX_HOME;
	process.env.PATH = "/test/bin";
	process.env.CODEX_HOME = "/test/codex-home";
	try {
		const codex = resolveOptions({
			provider: "codex",
			model: "gpt-5.6-luna",
			downloadDirectory: "downloads",
		});
		assert.equal(codex.reasoningEffort, "low");
		assert.equal(codex.apiKey, undefined);
		assert.equal(codex.apiKeyEnvironment, undefined);
		const environment = childEnvironment(codex);
		assert.equal(environment.PATH, "/test/bin");
		assert.equal(environment.CODEX_HOME, "/test/codex-home");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previousCodexHome;
	}
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
			provider: "codex",
			model: "gpt-5.4",
			downloadDirectory: "downloads",
			apiKey: "key",
		},
		{
			provider: "codex",
			model: "gpt-5.4",
			downloadDirectory: "downloads",
			apiKey: "",
		},
		{
			provider: "codex",
			model: "gpt-5.4",
			downloadDirectory: "downloads",
			endpointUrl: "https://example.com",
		},
		{
			provider: "codex",
			model: "gpt-5.4",
			downloadDirectory: "downloads",
			endpointUrl: "",
		},
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
		{ ...base, validatorLifecycle: "terminal" },
	] as unknown[];
	for (const options of invalid) {
		assert.throws(() => resolveOptions(options as BrowserAgentOptions), {
			code: "CONFIG_INVALID",
		});
	}
});

test("normalizes custom tools and rejects invalid definitions", () => {
	const schema = {
		type: "object",
		properties: {
			selector: { type: "string", minLength: 1 },
			limit: { type: ["integer", "null"], minimum: 1 },
		},
		required: ["selector"],
		additionalProperties: false,
	};
	const resolved = resolveOptions({
		...base,
		customTools: [
			{
				name: "read_heading",
				description: " Read a heading. ",
				arguments: schema,
				javascript: " async (args) => document.querySelector(args.selector)?.textContent ",
			},
		],
	});
	assert.deepEqual(resolved.customTools, [
		{
			name: "read_heading",
			description: "Read a heading.",
			arguments: schema,
			javascript:
				"async (args) => document.querySelector(args.selector)?.textContent",
		},
	]);
	assert.notEqual(resolved.customTools[0]?.arguments, schema);
	assert.deepEqual(resolveOptions(base).customTools, []);

	const circular: Record<string, unknown> = { type: "object" };
	circular.self = circular;
	for (const customTools of [
		"bad",
		[null],
		[
			{
				name: "Bad-Name",
				description: "description",
				arguments: { type: "object" },
				javascript: "() => null",
			},
		],
		[
			{
				name: "click",
				description: "description",
				arguments: { type: "object" },
				javascript: "() => null",
			},
		],
		[
			{
				name: "duplicate",
				description: "first",
				arguments: { type: "object" },
				javascript: "() => null",
			},
			{
				name: "duplicate",
				description: "second",
				arguments: { type: "object" },
				javascript: "() => null",
			},
		],
		[
			{
				name: "empty_description",
				description: " ",
				arguments: { type: "object" },
				javascript: "() => null",
			},
		],
		[
			{
				name: "array_arguments",
				description: "description",
				arguments: { type: "array" },
				javascript: "() => null",
			},
		],
		[
			{
				name: "empty_javascript",
				description: "description",
				arguments: { type: "object" },
				javascript: " ",
			},
		],
		[
			{
				name: "circular_schema",
				description: "description",
				arguments: circular,
				javascript: "() => null",
			},
		],
		[
			{
				name: "non_json_schema",
				description: "description",
				arguments: { type: "object", minimum: Number.NaN },
				javascript: "() => null",
			},
		],
		[
			{
				name: "undefined_schema_value",
				description: "description",
				arguments: { type: "object", title: undefined },
				javascript: "() => null",
			},
		],
		[
			{
				name: "class_schema",
				description: "description",
				arguments: Object.assign(new Date(), { type: "object" }),
				javascript: "() => null",
			},
		],
	] as unknown[]) {
		assert.throws(
			() =>
				resolveOptions({
					...base,
					customTools: customTools as never,
				}),
			{ code: "CONFIG_INVALID" },
		);
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
