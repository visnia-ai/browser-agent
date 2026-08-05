import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { resolveProviderRuntimeConfig } from "../src/agents/providers/ai-sdk.js";

describe("llm provider runtime config", () => {
	let originalOpenAI: string | undefined;
	let originalVLLM: string | undefined;
	let originalOpenRouter: string | undefined;

	beforeEach(() => {
		originalOpenAI = process.env.OPENAI_API_KEY;
		originalVLLM = process.env.VLLM_API_KEY;
		originalOpenRouter = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.VLLM_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
	});

	afterEach(() => {
		if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalOpenAI;
		if (originalVLLM === undefined) delete process.env.VLLM_API_KEY;
		else process.env.VLLM_API_KEY = originalVLLM;
		if (originalOpenRouter === undefined)
			delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = originalOpenRouter;
	});

	it("prefers an explicit provider API key over environment fallback", () => {
		process.env.VLLM_API_KEY = "env-token";

		const runtimeConfig = resolveProviderRuntimeConfig({
			provider: "vllm",
			model: "Qwen/Qwen3.6-27B",
			apiKey: "explicit-token",
			endpointUrl: "http://127.0.0.1:9000/v1",
		});

		assert.equal(runtimeConfig.apiKey, "explicit-token");
	});

	it("keeps environment API key fallback when no explicit key is provided", () => {
		process.env.VLLM_API_KEY = "env-token";

		const runtimeConfig = resolveProviderRuntimeConfig({
			provider: "vllm",
			model: "Qwen/Qwen3.6-27B",
			endpointUrl: "http://127.0.0.1:9000/v1",
		});

		assert.equal(runtimeConfig.apiKey, "env-token");
	});

	it("resolves OpenRouter defaults and prefers an explicit API key", () => {
		process.env.OPENROUTER_API_KEY = "env-openrouter-token";

		const runtimeConfig = resolveProviderRuntimeConfig({
			provider: "openrouter",
			model: "anthropic/claude-sonnet-4",
			reasoningEffort: "medium",
			apiKey: "explicit-openrouter-token",
		});

		assert.deepEqual(runtimeConfig, {
			provider: "openrouter",
			adapter: "openrouter",
			apiKey: "explicit-openrouter-token",
			endpointUrl: "https://openrouter.ai/api/v1",
		});
	});

	it("uses the OpenRouter environment key and allows endpoint overrides", () => {
		process.env.OPENROUTER_API_KEY = "env-openrouter-token";

		const runtimeConfig = resolveProviderRuntimeConfig({
			provider: "openrouter",
			model: "openai/gpt-5.4",
			reasoningEffort: "low",
			endpointUrl: "https://openrouter-proxy.test/v1",
		});

		assert.equal(runtimeConfig.apiKey, "env-openrouter-token");
		assert.equal(
			runtimeConfig.endpointUrl,
			"https://openrouter-proxy.test/v1",
		);
	});

	it("rejects OpenRouter without an API key", () => {
		assert.throws(
			() =>
				resolveProviderRuntimeConfig({
					provider: "openrouter",
					model: "anthropic/claude-sonnet-4",
					reasoningEffort: "medium",
				}),
			"Missing API key for provider 'openrouter'",
		);
	});

	it("rejects OpenRouter routing on another provider", () => {
		assert.throws(
			() =>
				resolveProviderRuntimeConfig({
					provider: "openai",
					model: "gpt-5.4",
					reasoningEffort: "low",
					apiKey: "key",
					openrouterProvider: "baseten",
				}),
			"openrouterProvider can only be used with provider 'openrouter'",
		);
	});
});
