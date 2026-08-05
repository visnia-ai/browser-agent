import { assert } from "chai";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import { formatMemoryResultBlock } from "../src/agents/executor-utils/extract-data-memory.js";
import { extractMemoryResults } from "../src/agents/executor-utils/memory-results.js";

describe("extract_data memory formatting", () => {
	const items = [
		{ link: "https://example.com/item", summary: "## Title\n\nDetails" },
		{ link: "https://example.com/second", summary: "Second item" },
	];

	it("serializes model results directly as a YAML result list", () => {
		const memory = formatMemoryResultBlock(items);
		assert.deepStrictEqual(yaml.load(extractMemoryResults(memory)), items);
	});

	it("preserves model-owned links and summaries verbatim except whitespace", () => {
		const memory = formatMemoryResultBlock([
			{
				link: " https://example.com/item#details ",
				summary:
					" Top pick: [Product](https://example.com/item#details) ",
			},
		]);
		assert.deepStrictEqual(yaml.load(memory), [
			{
				link: "https://example.com/item#details",
				summary:
					"Top pick: [Product](https://example.com/item#details)",
			},
		]);
	});

	it("rejects empty items and fields", () => {
		assert.throws(
			() => formatMemoryResultBlock([]),
			/extract_data returned no items/,
		);
		assert.throws(
			() => formatMemoryResultBlock([{ link: "", summary: "value" }]),
			/empty link/,
		);
	});
});
