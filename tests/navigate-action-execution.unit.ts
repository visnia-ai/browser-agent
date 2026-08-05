import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";

describe("navigate action execution", () => {
	it("rejects external protocol navigations", async () => {
		const result = await executeActions({
			b: {} as never,
			actions: [
				{
					type: "navigate",
					url: "mailto:test@example.com?subject=Hello",
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-navigate-action-memory.txt",
		});

		assert.lengthOf(result.interactionErrors, 1);
		assert.include(
			result.interactionErrors[0] ?? "",
			"navigate only supports in-browser document URLs",
		);
	});
});
