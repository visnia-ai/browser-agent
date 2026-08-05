import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";

describe("evaluate action execution", () => {
	it("returns a bounded evaluation result through tool observations", async () => {
		const longResult = `3864805:${"x".repeat(5_000)}`;
		const result = await executeActions({
			b: {
				Runtime: {
					evaluate: async () => ({
						result: { value: longResult },
					}),
				},
			} as never,
			actions: [
				{
					type: "evaluate",
					script: "document.body.innerText.length",
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-evaluate-action-memory.txt",
		});

		assert.lengthOf(result.interactionErrors, 0);
		assert.lengthOf(result.toolObservations, 1);
		assert.match(
			result.toolObservations[0] ?? "",
			/^evaluate result \(5008 chars, truncated\): "3864805:/,
		);
		assert.lengthOf(
			JSON.parse(
				(result.toolObservations[0] ?? "").slice(
					(result.toolObservations[0] ?? "").indexOf(": ") + 2,
				),
			),
			4_000,
		);
	});

	it("reports an empty evaluation result explicitly", async () => {
		const result = await executeActions({
			b: {
				Runtime: {
					evaluate: async () => ({ result: { value: undefined } }),
				},
			} as never,
			actions: [{ type: "evaluate", script: "undefined" }],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-evaluate-action-empty-memory.txt",
		});

		assert.deepEqual(result.toolObservations, [
			'evaluate result (0 chars): ""',
		]);
	});
});
