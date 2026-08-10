import { assert } from "chai";
import { describe, it } from "mocha";
import {
	NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
	OPENAI_EXECUTOR_CONTEXT_POLICY,
} from "../src/agents/executor-context-policy.js";
import { getExecutorSystem } from "../src/agents/prompts.js";
import { featureFlags } from "../src/featureFlags.js";

describe("executor reasoning prompts", () => {
	it("uses the OpenAI reasoning-history policy without action context", () => {
		const prompt = getExecutorSystem({
			executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY,
		});

		assert.include(prompt, "reasoning_tokens field");
		assert.include(prompt, "do not copy reasoning_tokens");
		assert.notInclude(prompt, "previousStepStatus");
		assert.notInclude(prompt, "nextActionRationale");
		assert.isUndefined(featureFlags.maxThinkingTokenBudget);
		assert.deepEqual(featureFlags.yamlOutputStopSequences, []);
	});

	it("uses the non-OpenAI action-context policy without reasoning history", () => {
		const prompt = getExecutorSystem({
			executorContextPolicy: NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
		});

		assert.notInclude(prompt, "reasoning_tokens field");
		for (const field of [
			"previousStepStatus",
			"previousStepOutcome",
			"currentStateObservation",
			"nextActionRationale",
		]) {
			assert.include(prompt, field);
		}
	});

	it("keeps provider-side effort independent from executor prompt instructions", () => {
		const runAgentPrompt = getExecutorSystem({
			executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY,
		});

		assert.notInclude(runAgentPrompt, "previousStepStatus");
		assert.notInclude(
			runAgentPrompt,
			"ALWAYS THINK OR REASON BEFORE ANSWERING.",
		);
	});

	it("uses only current semantic ref instructions", () => {
		const prompt = getExecutorSystem({
			executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY,
		});

		assert.include(
			prompt,
			"Every ref must be present in the reconstructed current projection",
		);
	});

	it("keeps the fixed executor contract below the benchmark prompt budget", () => {
		const prompt = getExecutorSystem({
			executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY,
		});

		assert.isAtMost(prompt.length, 12_500);
		for (const contract of [
			"### Semantic Projection Format",
			"Every ref must be present",
			"upload_files:",
			"Never click that trigger first",
			"extract_data:",
			"never poll",
			"return_results:",
			"download_current_file:",
			"interactionErrors",
		]) {
			assert.include(prompt, contract);
		}
	});
});
