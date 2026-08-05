import { assert } from "chai";
import { describe, it } from "mocha";
import {
	getReasoningModelCapability,
	REASONING_MODEL_CAPABILITIES,
	validateReasoningConfiguration,
} from "../src/agents/reasoning-capabilities.js";
import {
	isProvider,
	isReasoningEffort,
	OPENROUTER_REASONING_EFFORTS,
	REASONING_EFFORTS,
	SUPPORTED_PROVIDERS,
} from "../src/llm-capabilities.js";

describe("reasoning model capabilities", () => {
	it("derives the provider type guard from the supported provider list", () => {
		for (const provider of SUPPORTED_PROVIDERS) {
			assert.isTrue(isProvider(provider));
		}
		assert.isFalse(isProvider("unsupported"));
	});

	it("derives the global effort values from the model registry", () => {
		const registeredEfforts = [
			...new Set([
				...OPENROUTER_REASONING_EFFORTS,
				...REASONING_MODEL_CAPABILITIES.flatMap((capability) => [
					...capability.reasoningEfforts,
				]),
			]),
		];

		assert.deepEqual(REASONING_EFFORTS, registeredEfforts);
		for (const reasoningEffort of REASONING_EFFORTS) {
			assert.isTrue(isReasoningEffort(reasoningEffort));
		}
		assert.isFalse(isReasoningEffort("unsupported"));
	});

	it("resolves every registered model or family", () => {
		for (const capability of REASONING_MODEL_CAPABILITIES) {
			const model =
				capability.match === "exact"
					? capability.model
					: `org/custom-${capability.model}-model`;
			assert.strictEqual(
				getReasoningModelCapability(capability.provider, model),
				capability,
			);
			assert.include(
				capability.reasoningEfforts,
				capability.defaultReasoningEffort,
			);
		}
	});

	it("accepts every registered effort", () => {
		for (const capability of REASONING_MODEL_CAPABILITIES) {
			const model =
				capability.match === "exact"
					? capability.model
					: `org/custom-${capability.model}-model`;
			for (const reasoningEffort of capability.reasoningEfforts) {
				assert.doesNotThrow(() =>
					validateReasoningConfiguration({
						provider: capability.provider,
						model,
						reasoningEffort,
					}),
				);
			}
		}
	});

	it("supports xhigh and max reasoning for every GPT-5.6 variant", () => {
		for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]) {
			const capability = getReasoningModelCapability("openai", model);
			assert.includeMembers(capability?.reasoningEfforts ?? [], ["xhigh", "max"]);
			for (const reasoningEffort of ["xhigh", "max"] as const) {
				assert.doesNotThrow(() =>
					validateReasoningConfiguration({
						provider: "openai",
						model,
						reasoningEffort,
					}),
				);
			}
		}
	});

	it("supports DeepSeek V4 Flash high and max reasoning", () => {
		const model = "deepseek-ai/DeepSeek-V4-Flash-0731";
		const capability = getReasoningModelCapability("vllm", model);

		assert.equal(capability?.defaultReasoningEffort, "high");
		assert.deepEqual(capability?.reasoningEfforts, ["none", "high", "max"]);
		for (const reasoningEffort of ["high", "max"] as const) {
			assert.doesNotThrow(() =>
				validateReasoningConfiguration({
					provider: "vllm",
					model,
					reasoningEffort,
				}),
			);
		}
		assert.throws(
			() =>
				validateReasoningConfiguration({
					provider: "vllm",
					model,
					reasoningEffort: "enabled",
				}),
			"Allowed values: none, high, max",
		);
	});

	it("rejects unknown models for validated providers", () => {
		for (const provider of ["openai", "together", "vllm"] as const) {
			assert.throws(
				() =>
					validateReasoningConfiguration({
						provider,
						model: "unknown-model",
						reasoningEffort: "none",
					}),
				`Unknown reasoning model 'unknown-model' for provider '${provider}'`,
			);
		}
	});

	it("rejects retired models", () => {
		for (const [provider, model] of [
			["openai", "gpt-5.2-codex"],
			["openai", "gpt-5.4-nano"],
			["together", "moonshotai/Kimi-K2.6"],
			["vllm", "MiniMaxAI/MiniMax-M2.5"],
		] as const) {
			assert.throws(() =>
				validateReasoningConfiguration({
					provider,
					model,
					reasoningEffort: "none",
				}),
			);
		}
	});

	it("rejects missing and unsupported efforts with allowed values", () => {
		assert.throws(
			() =>
				validateReasoningConfiguration({
					provider: "vllm",
					model: "Qwen/Qwen3.5-27B",
					reasoningEffort: undefined,
				}),
			"Missing reasoning_effort",
		);
		assert.throws(
			() =>
				validateReasoningConfiguration({
					provider: "together",
					model: "zai-org/GLM-5.2",
					reasoningEffort: "enabled",
				}),
			"Allowed values: none, high, max",
		);
	});

	it("requires and validates OpenRouter reasoning efforts for arbitrary models", () => {
		for (const reasoningEffort of OPENROUTER_REASONING_EFFORTS) {
			assert.doesNotThrow(() =>
				validateReasoningConfiguration({
					provider: "openrouter",
					model: "vendor/changing-model-id",
					reasoningEffort,
				}),
			);
		}
		assert.throws(
			() =>
				validateReasoningConfiguration({
					provider: "openrouter",
					model: "vendor/model",
				}),
			"Missing reasoning_effort",
		);
		for (const reasoningEffort of ["max", "enabled"] as const) {
			assert.throws(
				() =>
					validateReasoningConfiguration({
						provider: "openrouter",
						model: "vendor/model",
						reasoningEffort,
					}),
				"Allowed values: none, minimal, low, medium, high, xhigh",
			);
		}
	});

	it("leaves out-of-scope providers unchanged", () => {
		for (const provider of ["anthropic", "google"] as const) {
			assert.doesNotThrow(() =>
				validateReasoningConfiguration({
					provider,
					model: "any-model",
					reasoningEffort: undefined,
				}),
			);
		}
	});
});
