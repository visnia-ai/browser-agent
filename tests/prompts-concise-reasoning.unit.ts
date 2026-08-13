import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import {
	NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
	OPENAI_EXECUTOR_CONTEXT_POLICY,
} from "../src/agents/executor-context-policy.js";
import { getExecutorSystem } from "../src/agents/prompts.js";
import { featureFlags } from "../src/featureFlags.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";

describe("executor reasoning prompts", () => {
	const originalPageObservationMode = configFeatureFlags.pageObservationMode;

	beforeEach(() => {
		setConfigFeatureFlags({ pageObservationMode: "semantic" });
	});

	afterEach(() => {
		setConfigFeatureFlags({
			pageObservationMode: originalPageObservationMode,
		});
	});

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

	it("teaches request-driven Markdown reads without enforcing batching", () => {
		setConfigFeatureFlags({ pageObservationMode: "markdown" });
		const prompt = getExecutorSystem({
			executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY,
		});

		assert.include(prompt, "pageObservation contains live-DOM CommonMark");
		assert.include(
			prompt,
			"Broad bootstrap/read_page and sparse find_page observations are content-only",
		);
		assert.include(prompt, "read_page takes no arguments");
		assert.include(prompt, "find_page takes one visible-text query string");
		assert.include(prompt, "project_page takes one ref or CSS selector");
		assert.include(prompt, "across the main document and addressable frames");
		assert.include(prompt, "containing only navigate receives a broad read automatically");
		assert.include(prompt, "deliberately exposes no action refs");
		assert.include(prompt, "project the narrowest useful stable CSS scope");
		assert.include(prompt, "with navigate instead of projecting it");
		assert.include(prompt, "preparation for one interaction phase");
		assert.include(prompt, 'Avoid "body" or "main" merely to refresh refs');
		assert.include(prompt, "batch the complete interaction followed by read_page");
		assert.include(prompt, "usually batch the action(s)");
		assert.include(prompt, "Do not mechanically append read_page");
		assert.include(prompt, "Prefer project_page whenever");
		assert.include(prompt, "reported unchanged");
		assert.include(prompt, "guidance, not a required ordering");
		assert.notInclude(prompt, "Semantic Projection Format");
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
