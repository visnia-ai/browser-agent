import { assert } from "chai";
import { describe, it } from "mocha";
import {
	NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
	OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY,
	OPENAI_EXECUTOR_CONTEXT_POLICY,
	resolveExecutorContextPolicy,
} from "../src/agents/executor-context-policy.js";
import { getExecutorSystem } from "../src/agents/prompts.js";

describe("executor context policy", () => {
	it("classifies direct OpenAI, Codex, and OpenAI models through OpenRouter under the OpenAI policy", () => {
		for (const provider of ["openai", "codex"] as const) {
			assert.strictEqual(
				resolveExecutorContextPolicy({ provider, model: "gpt-5.6" }, false),
				OPENAI_EXECUTOR_CONTEXT_POLICY,
			);
		}
		assert.strictEqual(
			resolveExecutorContextPolicy({
				provider: "openrouter",
				model: "  OpenAI/GPT-5.6  ",
			}),
			OPENAI_EXECUTOR_CONTEXT_POLICY,
		);
		assert.isTrue(OPENAI_EXECUTOR_CONTEXT_POLICY.includeReasoningHistory);
	});

	it("enables action-context fields for direct OpenAI, Codex, and OpenRouter OpenAI models", () => {
		for (const llm of [
			{ provider: "openai" as const, model: "gpt-5.6" },
			{ provider: "codex" as const, model: "gpt-5.6" },
			{ provider: "openrouter" as const, model: "openai/gpt-5.6" },
		]) {
			assert.strictEqual(
				resolveExecutorContextPolicy(llm, true),
				OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY,
			);
		}
	});

	it("classifies every non-OpenAI/Codex model by model owner, not transport", () => {
		for (const llm of [
			{ provider: "openrouter" as const, model: "z-ai/glm-5.2" },
			{ provider: "anthropic" as const, model: "claude-opus-4-6" },
			{ provider: "google" as const, model: "gemini-3.1-pro" },
			{ provider: "together" as const, model: "moonshotai/kimi-k2.5" },
			{ provider: "vllm" as const, model: "gpt-shaped-name" },
		]) {
			assert.strictEqual(
				resolveExecutorContextPolicy(llm, true),
				NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
			);
		}
		assert.isFalse(NON_OPENAI_EXECUTOR_CONTEXT_POLICY.includeReasoningHistory);
	});

	it("includes provider-agnostic reasoning history and action-context fields for Codex", () => {
		const prompt = getExecutorSystem({
			executorContextPolicy: resolveExecutorContextPolicy(
				{ provider: "codex", model: "gpt-5.6" },
				true,
			),
		});

		assert.include(prompt, "fallible reasoning from earlier executor steps");
		assert.include(prompt, "previousStepStatus");
	});

	it("keeps mixed model policies isolated in concurrent prompt construction", async () => {
		const [openAI, nonOpenAI] = await Promise.all([
			Promise.resolve().then(() =>
				getExecutorSystem({
					executorContextPolicy: resolveExecutorContextPolicy({
						provider: "openrouter",
						model: "openai/gpt-5.6",
					}),
				}),
			),
			Promise.resolve().then(() =>
				getExecutorSystem({
					executorContextPolicy: resolveExecutorContextPolicy({
						provider: "openrouter",
						model: "z-ai/glm-5.2",
					}),
				}),
			),
		]);

		assert.include(openAI, "fallible reasoning from earlier executor steps");
		assert.notInclude(openAI, "previousStepStatus");
		assert.notInclude(
			nonOpenAI,
			"fallible reasoning from earlier executor steps",
		);
		assert.include(nonOpenAI, "previousStepStatus");
	});
});
