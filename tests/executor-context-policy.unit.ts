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
	it("classifies direct OpenAI and OpenAI models through OpenRouter as OpenAI", () => {
		assert.strictEqual(
			resolveExecutorContextPolicy(
				{ provider: "openai", model: "gpt-5.6" },
				false,
			),
			OPENAI_EXECUTOR_CONTEXT_POLICY,
		);
		assert.strictEqual(
			resolveExecutorContextPolicy({
				provider: "openrouter",
				model: "  OpenAI/GPT-5.6  ",
			}),
			OPENAI_EXECUTOR_CONTEXT_POLICY,
		);
	});

	it("enables action-context fields for direct and OpenRouter OpenAI models", () => {
		for (const llm of [
			{ provider: "openai" as const, model: "gpt-5.6" },
			{ provider: "openrouter" as const, model: "openai/gpt-5.6" },
		]) {
			assert.strictEqual(
				resolveExecutorContextPolicy(llm, true),
				OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY,
			);
		}
	});

	it("classifies every non-OpenAI model by model owner, not transport", () => {
		for (const llm of [
			{ provider: "openrouter" as const, model: "z-ai/glm-5.2" },
			{ provider: "together" as const, model: "moonshotai/kimi-k2.5" },
			{ provider: "vllm" as const, model: "gpt-shaped-name" },
		]) {
			assert.strictEqual(
				resolveExecutorContextPolicy(llm, true),
				NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
			);
		}
	});

	it("includes both OpenAI reasoning history and action-context prompt fields when enabled", () => {
		const prompt = getExecutorSystem({
			executorContextPolicy: resolveExecutorContextPolicy(
				{ provider: "openai", model: "gpt-5.6" },
				true,
			),
		});

		assert.include(prompt, "reasoning_tokens field");
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

		assert.include(openAI, "reasoning_tokens field");
		assert.notInclude(openAI, "previousStepStatus");
		assert.notInclude(nonOpenAI, "reasoning_tokens field");
		assert.include(nonOpenAI, "previousStepStatus");
	});
});
