import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { getExecutorSystemBase } from "../src/agents/prompts.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";

describe("executor memory prompt", () => {
	const originalExtractDataWholeContext =
		configFeatureFlags.extractDataWholeContext;

	afterEach(() => {
		setConfigFeatureFlags({
			extractDataWholeContext: originalExtractDataWholeContext,
		});
	});

	it("documents rootless whole-document extraction independently", () => {
		setConfigFeatureFlags({ extractDataWholeContext: true });
		const prompt = getExecutorSystemBase();

		assert.include(prompt, "Use the bare extract_data tool name");
		assert.include(prompt, "entire current semantic projection");
		assert.notInclude(prompt, 'extract_data: "!a"');
		assert.notInclude(prompt, "one existing ref");
	});

	it("documents memory_read for preloaded context and mutable scratchpad behavior", () => {
		const prompt = getExecutorSystemBase();

		for (const contract of [
			"runtime-pinned workspace/file context",
			"mutable browser scratchpad",
			"extracted page data/result memory",
			"Appends intermediate non-result notes",
			"local Markdown conversion for CSV/DOCX/XLSX",
			"scanned PDFs without a text layer are unsupported",
			"memory_clear",
			"memory_result",
			"Persist final-result page evidence asynchronously",
			"waits for pending extraction automatically",
			"never poll",
			"appears in interactionErrors on the next step",
			"completed extract_data",
			"memoryContent after memory_read",
			'extract_data: "r2f,r8a"',
			"comma-separated list of refs",
			"Writes items to memory_result",
			"memoryAvailable",
		]) {
			assert.include(prompt, contract);
		}
		assert.notInclude(prompt, "memory_return_results");
		assert.notInclude(prompt, "websiteToolResults");
		assert.notInclude(prompt, "website_tool");
		assert.notInclude(prompt, "\ndone:");
	});

	it("documents paste_file for exact workspace file transfer", () => {
		const prompt = getExecutorSystemBase();

		assert.include(prompt, "paste_file:");
		assert.include(prompt, "exact text contents");
		assert.include(
			prompt,
			"workspaceFiles aids discovery but is not an allowlist",
		);
		assert.include(prompt, "prefer this over type/memory_read");
	});

	it("documents request-based agent_takeover when enabled", () => {
		const original = { ...configFeatureFlags };
		try {
			setConfigFeatureFlags({ agentTakeoverTool: true });
			const prompt = getExecutorSystemBase();
			assert.include(prompt, "agent_takeover:");
			assert.include(prompt, "agent_takeover: {request}");
			assert.include(
				prompt,
				"Only for bounded local/workspace/downloaded-file work",
			);
			assert.include(prompt, "non-empty request");
			assert.include(prompt, "output path/format and verification");
			assert.include(prompt, "Prefer outputs under ./downloads");
			assert.include(prompt, "use returned memoryContent");
			assert.notInclude(prompt, "sourceHints");
		} finally {
			setConfigFeatureFlags(original);
		}
	});

	it("omits agent_takeover when disabled", () => {
		const original = { ...configFeatureFlags };
		try {
			setConfigFeatureFlags({ agentTakeoverTool: false });
			const prompt = getExecutorSystemBase();
			assert.notInclude(prompt, `  - agent_takeover:`);
			assert.notInclude(prompt, "agent_takeover:\n  - Use only");
		} finally {
			setConfigFeatureFlags(original);
		}
	});
});
