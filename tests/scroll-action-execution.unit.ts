import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { replaceSemanticRefSnapshot } from "../src/browser/semantic-ref-registry.js";

function createScrollActionBrowser(): any {
	const browser = {
		DOM: {
			getDocument: async () => ({ root: { nodeId: 1 } }),
			pushNodesByBackendIdsToFrontend: async () => ({ nodeIds: [2] }),
			resolveNode: async ({ nodeId }: { nodeId: number }) => ({
				object: { objectId: `obj-scroll-${nodeId}` },
			}),
			scrollIntoViewIfNeeded: async () => undefined,
		},
		Runtime: {
			callFunctionOn: async (input: {
				functionDeclaration: string;
				arguments?: Array<{ value: unknown }>;
			}) => {
				if (
					input.functionDeclaration.includes("getBoundingClientRect")
				) {
					return { result: { value: "" } };
				}
				if (input.functionDeclaration.includes("WheelEvent")) {
					return { result: { value: true } };
				}
				return { result: { value: undefined } };
			},
		},
	};
	replaceSemanticRefSnapshot(browser, [
		{
			ref: "rs1",
			backendNodeId: 12,
			role: "region",
			capabilities: ["scroll"],
		},
	]);
	return browser;
}

describe("scroll action execution", () => {
	it("dispatches ref-targeted scroll without interaction errors", async () => {
		const result = await executeActions({
			b: createScrollActionBrowser(),
			actions: [
				{
					type: "scroll",
					ref: "rs1",
					deltaY: 280,
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-scroll-action-memory.txt",
		});

		assert.deepEqual(result.interactionErrors, []);
		assert.isFalse(result.pendingMemoryRead);
	});

	it("reports validation errors when scroll deltas are zero", async () => {
		const result = await executeActions({
			b: createScrollActionBrowser(),
			actions: [
				{
					type: "scroll",
					ref: "rs2",
					deltaX: 0,
					deltaY: 0,
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-scroll-action-memory.txt",
		});

		assert.strictEqual(result.interactionErrors.length, 1);
		assert.include(result.interactionErrors[0], "scroll(ref=rs2");
		assert.include(result.interactionErrors[0], "non-zero delta");
	});
});
