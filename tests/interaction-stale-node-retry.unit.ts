import { assert } from "chai";
import { describe, it } from "mocha";
import { click } from "../src/browser/interaction/click.js";
import { type as typeIntoElement } from "../src/browser/interaction/type.js";
import { replaceSemanticRefSnapshot } from "../src/browser/semantic-ref-registry.js";
import type { Browser } from "../src/browser/types.js";

function createBaseBrowser(): Browser {
	return {
		port: 9222,
		client: {} as any,
		chrome: {} as any,
		Page: {} as any,
		DOMSnapshot: {} as any,
		Target: {} as any,
		Accessibility: {} as any,
		Runtime: {} as any,
		DOM: {} as any,
		Input: {} as any,
	};
}

describe("interaction stale node retry", () => {
	it("click retries once when the resolved node becomes stale", async () => {
		let querySelectorCalls = 0;
		let scrollCalls = 0;
		const browser = {
			...createBaseBrowser(),
			Runtime: {
				callFunctionOn: async (params: {
					functionDeclaration?: string;
					returnByValue?: boolean;
				}) => {
					if (
						params.functionDeclaration?.includes(
							"getBoundingClientRect",
						)
					) {
						return { result: { value: "" } };
					}
					if (params.returnByValue) {
						return { result: { value: true } };
					}
					return { result: {} };
				},
				evaluate: async () => ({ result: {} }),
			} as any,
			DOM: {
				getDocument: async () => {
					querySelectorCalls += 1;
					return {
						root: {
							nodeId: 1,
							children: [
								{
									nodeId: querySelectorCalls + 1,
									attributes: ["data-bid", "a"],
								},
							],
						},
					};
				},
				pushNodesByBackendIdsToFrontend: async () => ({
					nodeIds: [querySelectorCalls + 1],
				}),
				resolveNode: async (params: { nodeId: number }) => ({
					object: { objectId: `object-${params.nodeId}` },
				}),
				scrollIntoViewIfNeeded: async () => {
					scrollCalls += 1;
					if (scrollCalls === 1) {
						throw new Error("Could not find node with given id");
					}
				},
				getBoxModel: async () => ({
					model: {
						content: [0, 0, 20, 0, 20, 20, 0, 20],
					},
				}),
			} as any,
			Input: {
				dispatchMouseEvent: async () => undefined,
			} as any,
		} satisfies Browser;
		replaceSemanticRefSnapshot(browser, [
			{
				ref: "a",
				backendNodeId: 101,
				role: "button",
				capabilities: ["click"],
			},
		]);

		await click(browser, "a");

		assert.strictEqual(querySelectorCalls, 2);
		assert.strictEqual(scrollCalls, 2);
	});

	it("type retries once when the resolved node becomes stale", async () => {
		let querySelectorCalls = 0;
		let focusCalls = 0;
		let typedChars = 0;
		const browser = {
			...createBaseBrowser(),
			Runtime: {
				callFunctionOn: async (params: {
					functionDeclaration?: string;
				}) => {
					if (
						params.functionDeclaration?.includes(
							"getBoundingClientRect",
						)
					) {
						return { result: { value: "" } };
					}
					return { result: {} };
				},
			} as any,
			DOM: {
				getDocument: async () => {
					querySelectorCalls += 1;
					return {
						root: {
							nodeId: 1,
							children: [
								{
									nodeId: querySelectorCalls + 1,
									attributes: ["data-bid", "a"],
								},
							],
						},
					};
				},
				pushNodesByBackendIdsToFrontend: async () => ({
					nodeIds: [querySelectorCalls + 1],
				}),
				resolveNode: async (params: { nodeId: number }) => ({
					object: { objectId: `object-${params.nodeId}` },
				}),
				scrollIntoViewIfNeeded: async () => undefined,
				focus: async () => {
					focusCalls += 1;
					if (focusCalls === 1) {
						throw new Error("Could not find node with given id");
					}
				},
				describeNode: async () => ({
					node: { nodeName: "INPUT" },
				}),
			} as any,
			Input: {
				dispatchKeyEvent: async (params: { type: string }) => {
					if (params.type === "char") {
						typedChars += 1;
					}
				},
			} as any,
		} satisfies Browser;
		replaceSemanticRefSnapshot(browser, [
			{
				ref: "a",
				backendNodeId: 101,
				role: "textbox",
				capabilities: ["type"],
			},
		]);

		await typeIntoElement(browser, "a", "abc");

		assert.strictEqual(querySelectorCalls, 2);
		assert.strictEqual(focusCalls, 2);
		assert.strictEqual(typedChars, 3);
	});
});
