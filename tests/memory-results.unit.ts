import { assert } from "chai";
import { describe, it } from "mocha";
import { extractMemoryResults } from "../src/agents/executor-utils/memory-results.js";

describe("memory result extraction", () => {
	it("returns a valid YAML result list from extracted-data memory", () => {
		assert.strictEqual(
			extractMemoryResults(
				[
					"- link: https://example.com/one",
					"  summary: One",
					"- link: https://example.com/two",
					"  summary: Two",
				].join("\n"),
			),
			[
				"- link: https://example.com/one",
				"  summary: One",
				"- link: https://example.com/two",
				"  summary: Two",
			].join("\n"),
		);
	});

	it("rejects empty extracted-data memory", () => {
		assert.throws(() => extractMemoryResults(""), /empty memory_result/);
	});

	it("rejects non-list YAML", () => {
		assert.throws(
			() => extractMemoryResults("scratch note only"),
			/memory_result must be a YAML list/,
		);
	});

	it("rejects empty YAML lists", () => {
		assert.throws(
			() => extractMemoryResults("[]"),
			/memory_result YAML list must not be empty/,
		);
	});
});
