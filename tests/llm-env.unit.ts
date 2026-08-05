import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { resolveConfigFromEnv } from "../runtime/llm-env.js";
import type { Config } from "../src/utils.js";

describe("llm-env", () => {
	let originalOpenAI: string | undefined;
	let originalTogether: string | undefined;
	let originalVLLM: string | undefined;

	beforeEach(() => {
		originalOpenAI = process.env.OPENAI_API_KEY;
		originalTogether = process.env.TOGETHER_API_KEY;
		originalVLLM = process.env.VLLM_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.TOGETHER_API_KEY;
		delete process.env.VLLM_API_KEY;
	});

	afterEach(() => {
		if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalOpenAI;
		if (originalTogether === undefined) delete process.env.TOGETHER_API_KEY;
		else process.env.TOGETHER_API_KEY = originalTogether;
		if (originalVLLM === undefined) delete process.env.VLLM_API_KEY;
		else process.env.VLLM_API_KEY = originalVLLM;
	});

	it("preserves verifySuccess stage options when resolving config from env", () => {
		const originalOpenAI = process.env.OPENAI_API_KEY;
		const originalTogether = process.env.TOGETHER_API_KEY;
		const originalVllm = process.env.VLLM_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.TOGETHER_API_KEY;
		delete process.env.VLLM_API_KEY;
		const config: Config = {
			stageLLMs: {
				findTargetURL: {
					provider: "openai",
					model: "gpt-5.4",
					reasoningEffort: "low",
				},
				createChecklist: {
					provider: "openai",
					model: "gpt-5.4-mini",
					reasoningEffort: "low",
				},
				runAgent: {
					provider: "vllm",
					model: "Qwen/Qwen3.5-397B-A17B-GPTQ-Int4",
					endpointUrl: "http://127.0.0.1:9001/v1",
					reasoningEffort: "enabled",
				},
				dataExtraction: {
					provider: "openai",
					model: "gpt-5.4-mini",
					reasoningEffort: "low",
				},
				verifySuccess: {
					provider: "vllm",
					model: "Qwen/Qwen3.5-397B-A17B-GPTQ-Int4",
					endpointUrl: "http://127.0.0.1:9001/v1",
					reasoningEffort: "enabled",
				},
			},
			featureFlags: {
				preStepScreenshotInLatestUserPrompt: true,
				userTakeoverTool: true,
				authTakeover: false,
				agentTakeoverTool: false,
			},
			headless: false,
			maxSteps: 50,
			waitBetweenTasksMs: 0,
			taskRuns: 1,
			taskRunRetryCount: 0,
			concurrency: 1,
			tasks: [{ task: "test task" }],
			saveStepsContext: true,
			saveTaskLogs: false,
			stepMessagesJsonlPath: "tmp/context/steps.jsonl",
		};

		try {
			const resolved = resolveConfigFromEnv(config);

			assert.deepEqual(resolved.stageLLMs.verifySuccess, {
				provider: "vllm",
				model: "Qwen/Qwen3.5-397B-A17B-GPTQ-Int4",
				endpointUrl: "http://127.0.0.1:9001/v1",
				reasoningEffort: "enabled",
			});
		} finally {
			process.env.OPENAI_API_KEY = originalOpenAI;
			process.env.TOGETHER_API_KEY = originalTogether;
			process.env.VLLM_API_KEY = originalVllm;
		}
	});
});
