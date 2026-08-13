import { assert } from "chai";
import { describe, it } from "mocha";
import { resolveElement } from "../src/browser/interaction/utils.js";
import {
	createSemanticRefFingerprint,
	replaceSemanticRefSnapshot,
} from "../src/browser/semantic-ref-registry.js";
import type { Browser } from "../src/browser/types.js";

function createBaseBrowser(): Browser {
	return {
		port: 9222,
		client: {} as any,
		chrome: {} as any,
		Page: {} as any,
		Runtime: {} as any,
		DOMSnapshot: {} as any,
		Input: {} as any,
		Target: {} as any,
		Accessibility: {} as any,
		DOM: {} as any,
	};
}

describe("resolveElement", () => {
	it("resolves an opaque semantic ref through its backend node target", async () => {
		const browser = {
			...createBaseBrowser(),
			DOM: {
				getDocument: async () => ({ root: { nodeId: 1 } }),
				pushNodesByBackendIdsToFrontend: async () => ({
					nodeIds: [12],
				}),
				resolveNode: async ({ nodeId }: { nodeId: number }) => ({
					object: { objectId: `object-${nodeId}` },
				}),
			} as any,
		} satisfies Browser;
		replaceSemanticRefSnapshot(browser, [
			{
				ref: "rabc",
				backendNodeId: 120,
				role: "button",
				capabilities: ["click"],
			},
		]);

		const result = await resolveElement(browser, "rabc");
		assert.deepEqual(result, { nodeId: 12, objectId: "object-12" });
	});

	it("trims an opaque semantic ref before resolving it", async () => {
		const browser = {
			...createBaseBrowser(),
			DOM: {
				getDocument: async () => ({ root: { nodeId: 1 } }),
				pushNodesByBackendIdsToFrontend: async () => ({
					nodeIds: [11],
				}),
				resolveNode: async () => ({
					object: { objectId: "object-11" },
				}),
			} as any,
		} satisfies Browser;
		replaceSemanticRefSnapshot(browser, [
			{
				ref: "r2b",
				backendNodeId: 110,
				role: "textbox",
				capabilities: ["type"],
			},
		]);

		const result = await resolveElement(browser, "  r2b  ");
		assert.deepEqual(result, { nodeId: 11, objectId: "object-11" });
	});

	it("resolves a shadow-DOM target from its projection backend node", async () => {
		let getDocumentArgs: unknown;
		const browser = {
			...createBaseBrowser(),
			DOM: {
				getDocument: async (args: unknown) => {
					getDocumentArgs = args;
					return { root: { nodeId: 9 } };
				},
				pushNodesByBackendIdsToFrontend: async () => ({
					nodeIds: [102],
				}),
				resolveNode: async ({ nodeId }: { nodeId: number }) => ({
					object: { objectId: `object-${nodeId}` },
				}),
			} as any,
		} satisfies Browser;
		replaceSemanticRefSnapshot(browser, [
			{
				ref: "rshadow",
				backendNodeId: 1020,
				role: "button",
				capabilities: ["click"],
			},
		]);

		const result = await resolveElement(browser, "rshadow");
		assert.isUndefined(getDocumentArgs);
		assert.deepEqual(result, { nodeId: 102, objectId: "object-102" });
	});

	it("recovers a stale backend node from one exact semantic fingerprint match", async () => {
		const requestedBackendNodeIds: number[] = [];
		const browser = {
			...createBaseBrowser(),
			Accessibility: {
				getFullAXTree: async () => ({
					nodes: [
						{
							nodeId: "ax-old-page-search",
							backendDOMNodeId: 210,
							role: { type: "role", value: "link" },
							name: { type: "computedString", value: "Search" },
							properties: [
								{
									name: "url",
									value: {
										type: "string",
										value: "https://example.test/movie",
									},
								},
							],
						},
						{
							nodeId: "ax-intended-search",
							backendDOMNodeId: 220,
							role: { type: "role", value: "link" },
							name: { type: "computedString", value: "Search" },
							properties: [
								{
									name: "url",
									value: {
										type: "string",
										value: "https://example.test/search",
									},
								},
							],
						},
					],
				}),
			} as any,
			DOM: {
				getDocument: async () => ({ root: { nodeId: 1 } }),
				pushNodesByBackendIdsToFrontend: async ({
					backendNodeIds,
				}: {
					backendNodeIds: number[];
				}) => {
					requestedBackendNodeIds.push(backendNodeIds[0]);
					return { nodeIds: backendNodeIds[0] === 220 ? [22] : [0] };
				},
				resolveNode: async ({ nodeId }: { nodeId: number }) => ({
					object: { objectId: `object-${nodeId}` },
				}),
			} as any,
		} satisfies Browser;
		replaceSemanticRefSnapshot(browser, [
			{
				ref: "rsearch",
				backendNodeId: 120,
				role: "link",
				capabilities: ["click"],
				fingerprint: createSemanticRefFingerprint({
					role: "link",
					name: "Search",
					url: "https://example.test/search",
				}),
			},
		]);

		const result = await resolveElement(browser, "rsearch");
		assert.deepEqual(result, { nodeId: 22, objectId: "object-22" });
		assert.deepEqual(requestedBackendNodeIds, [120, 220]);
	});

	it("does not guess when a stale ref fingerprint has multiple exact matches", async () => {
		const browser = {
			...createBaseBrowser(),
			Accessibility: {
				getFullAXTree: async () => ({
					nodes: [310, 320].map((backendDOMNodeId) => ({
						nodeId: `ax-${backendDOMNodeId}`,
						backendDOMNodeId,
						role: { type: "role", value: "button" },
						name: { type: "computedString", value: "Save" },
						properties: [],
					})),
				}),
			} as any,
			DOM: {
				getDocument: async () => ({ root: { nodeId: 1 } }),
				pushNodesByBackendIdsToFrontend: async () => ({ nodeIds: [0] }),
				resolveNode: async () => ({ object: {} }),
			} as any,
		} satisfies Browser;
		replaceSemanticRefSnapshot(browser, [
			{
				ref: "rsave",
				backendNodeId: 300,
				role: "button",
				capabilities: ["click"],
				fingerprint: createSemanticRefFingerprint({
					role: "button",
					name: "Save",
				}),
			},
		]);

		try {
			await resolveElement(browser, "rsave");
			assert.fail("Expected ambiguous recovery to retain the stale-ref failure");
		} catch (error) {
			assert.include(
				String(error),
				"Semantic ref target is stale in the current page: ref=rsave",
			);
		}
	});

	it("throws a clear error when the ref is absent from the current projection", async () => {
		const browser = {
			...createBaseBrowser(),
			DOM: {
				getDocument: async () => ({
					root: {
						nodeId: 1,
						children: [
							{ nodeId: 11, attributes: ["data-bid", "other"] },
						],
					},
				}),
				resolveNode: async () => ({
					object: { objectId: "object-11" },
				}),
			} as any,
		} satisfies Browser;

		try {
			await resolveElement(browser, "missing");
			assert.fail("Expected resolveElement to throw");
		} catch (error) {
			assert.include(
				String(error),
				"Semantic ref is not present in the current projection: ref=missing",
			);
		}
	});
});
