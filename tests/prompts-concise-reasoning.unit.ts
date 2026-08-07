import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { getExecutorSystem } from "../src/agents/prompts.js";
import { featureFlags } from "../src/featureFlags.js";

describe("executor reasoning prompts", () => {
	const originalReasoningHistory =
		featureFlags.includeReasoningTokensInPreviousSteps;
	const originalActionContextFields = featureFlags.executorActionContextFields;

	afterEach(() => {
		featureFlags.includeReasoningTokensInPreviousSteps =
			originalReasoningHistory;
		featureFlags.executorActionContextFields = originalActionContextFields;
	});

	it("uses the Luna benchmark reasoning and action-context defaults for every provider", () => {
		assert.isTrue(featureFlags.includeReasoningTokensInPreviousSteps);
		assert.isFalse(featureFlags.executorActionContextFields);
		assert.isUndefined(featureFlags.maxThinkingTokenBudget);
		assert.deepEqual(featureFlags.yamlOutputStopSequences, []);

		for (const provider of ["openai", "openrouter", "together", "vllm"] as const) {
			const prompt = getExecutorSystem({ provider });
			assert.include(prompt, "reasoning_tokens field");
			assert.notInclude(prompt, "previousStepStatus");
			assert.notInclude(prompt, "nextActionRationale");
		}
	});

	it("gates action-context fields for every executor provider", () => {
		featureFlags.executorActionContextFields = false;
		for (const prompt of [
			getExecutorSystem({ provider: "vllm" }),
			getExecutorSystem({ provider: "openai" }),
			getExecutorSystem(),
		]) {
			for (const field of [
				"previousStepStatus",
				"previousStepOutcome",
				"currentStateObservation",
				"nextActionRationale",
			]) {
				assert.notInclude(prompt, field);
			}
		}

		featureFlags.executorActionContextFields = true;
		for (const prompt of [
			getExecutorSystem({ provider: "vllm" }),
			getExecutorSystem({ provider: "openai" }),
			getExecutorSystem(),
		]) {
			for (const field of [
				"previousStepStatus",
				"previousStepOutcome",
				"currentStateObservation",
				"nextActionRationale",
			]) {
				assert.include(prompt, field);
			}
		}
	});

	it("keeps provider-side effort independent from executor prompt instructions", () => {
		featureFlags.executorActionContextFields = false;
		const runAgentPrompt = getExecutorSystem();

		assert.notInclude(runAgentPrompt, "previousStepStatus");
		assert.notInclude(
			runAgentPrompt,
			"ALWAYS THINK OR REASON BEFORE ANSWERING.",
		);
	});

	it("warns that previous reasoning tokens are fallible and not response fields", () => {
		featureFlags.includeReasoningTokensInPreviousSteps = true;
		const enabledPrompt = getExecutorSystem();
		assert.include(enabledPrompt, "reasoning_tokens field");
		assert.include(enabledPrompt, "do not copy reasoning_tokens");

		featureFlags.includeReasoningTokensInPreviousSteps = false;
		assert.notInclude(getExecutorSystem(), "reasoning_tokens field");
	});

	it("uses only current semantic ref instructions", () => {
		const prompt = getExecutorSystem();

		assert.include(
			prompt,
			"Every ref must be present in the reconstructed current projection",
		);
	});

	it("keeps the fixed executor contract below the benchmark prompt budget", () => {
		const prompt = getExecutorSystem();

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
