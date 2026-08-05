import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { findTargetURL } from "../src/agents/target-url.js";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";

describe("target URL discovery", () => {
	afterEach(() => {
		__setProviderOverrideForTests("vllm", null);
	});

	it("forwards the configured URL-discovery reasoning effort", async () => {
		let reasoningEffort: string | undefined;

		__setProviderOverrideForTests("vllm", async (args) => {
			reasoningEffort = args.options.reasoningEffort;
			return {
				content: 'url: "https://www.example.com"',
				usage: {
					input_tokens: 5,
					output_tokens: 4,
					total_tokens: 9,
				},
				reasoning_tokens: "",
			};
		});

		const url = await findTargetURL("Find a useful site.", {
			provider: "vllm",
			model: "Qwen/Qwen3.5-4B",
			reasoningEffort: "none",
		});

		assert.strictEqual(url, "https://www.example.com");
		assert.strictEqual(reasoningEffort, "none");
	});
});
