import { assert } from "chai";
import { describe, it } from "mocha";
import type { Action } from "../src/agents/types.js";
import {
	canSkipExecutorStepDelay,
	getExecutorStepDelayMs,
} from "../src/core/executor-step-delay.js";

describe("optimized executor step delays", () => {
	it("skips the delay for empty and agent-local action batches", () => {
		const actions: Action[] = [
			{ type: "extract_data", root: "results" },
			{ type: "memory_write", content: "progress" },
			{ type: "memory_read" },
			{ type: "wait", ms: 100 },
		];

		assert.isTrue(canSkipExecutorStepDelay([]));
		assert.isTrue(canSkipExecutorStepDelay(actions));
		assert.strictEqual(getExecutorStepDelayMs(actions, false), 500);
		assert.strictEqual(getExecutorStepDelayMs(actions, true), 0);
	});

	it("preserves settling when any action can change browser state", () => {
		const pageChangingActions: Action[] = [
			{ type: "click", bid: "1" },
			{ type: "type", bid: "2", text: "query" },
			{ type: "scroll", bid: "3", deltaY: 500 },
			{ type: "navigate", url: "https://example.com" },
			{ type: "evaluate", script: "document.body.click()" },
		];

		for (const action of pageChangingActions) {
			assert.isFalse(
				canSkipExecutorStepDelay([
					{ type: "memory_write", content: "progress" },
					action,
				]),
				action.type,
			);
			assert.strictEqual(getExecutorStepDelayMs([action], true), 500);
		}
	});
});
