import { assert } from "chai";
import { describe, it } from "mocha";
import { getSimplifiedDOM } from "../src/browser/simplify-dom.js";

function createScrollMarkersSnapshot(): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"DIV",
		"block",
		"visible",
		"1",
		"default",
		"auto",
		"hidden",
		"",
		"container enabled",
		"container scrolling",
		"container normal",
	];

	return {
		documents: [
			{
				documentURL: 10,
				title: 10,
				baseURL: 10,
				contentLanguage: 10,
				encodingName: 10,
				publicId: 10,
				systemId: 10,
				frameId: 10,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 2, 2, 3, 4, 5],
					nodeType: [9, 1, 1, 1, 1, 1, 3, 3, 3],
					nodeName: [0, 1, 2, 3, 3, 3, 0, 0, 0],
					nodeValue: [10, 10, 10, 10, 10, 10, 11, 12, 13],
					attributes: [[], [], [], [], [], [], [], [], []],
					backendNodeId: [0, 301, 302, 401, 402, 403, 0, 0, 0],
				},
				layout: {
					nodeIndex: [1, 2, 3, 4, 5],
					bounds: [
						[0, 0, 1200, 800],
						[0, 0, 1200, 760],
						[0, 0, 320, 80],
						[0, 0, 320, 80],
						[0, 0, 320, 80],
					],
					styles: [
						[4, 5, 6, 7, 9, 9],
						[4, 5, 6, 7, 9, 9],
						[4, 5, 6, 7, 8, 9],
						[4, 5, 6, 7, 9, 8],
						[4, 5, 6, 7, 9, 9],
					],
					text: [10, 10, 10, 10, 10],
					stackingContexts: { index: [] },
				},
				textBoxes: {
					layoutIndex: [],
					bounds: [],
					start: [],
					length: [],
				},
			},
		],
		strings,
	};
}

function createMockBrowser(snapshot: any): any {
	const objectByNodeId = new Map<number, string>([
		[7001, "obj-401"],
		[7002, "obj-402"],
	]);

	return {
		DOMSnapshot: {
			captureSnapshot: async () => snapshot,
		},
		DOM: {
			pushNodesByBackendIdsToFrontend: async ({
				backendNodeIds,
			}: {
				backendNodeIds: number[];
			}) => {
				assert.deepEqual(backendNodeIds, [401, 402]);
				return { nodeIds: [7001, 7002] };
			},
			resolveNode: async ({ nodeId }: { nodeId: number }) => ({
				object: { objectId: objectByNodeId.get(nodeId) },
			}),
		},
		Runtime: {
			callFunctionOn: async ({ objectId }: { objectId: string }) => ({
				result: { value: objectId === "obj-402" },
			}),
		},
	};
}

describe("simplify-dom scroll markers", () => {
	it("adds scroll-enabled and scrollable markers to simplified DOM", async () => {
		const snapshot = createScrollMarkersSnapshot();
		const browser = createMockBrowser(snapshot);
		const simplified = await getSimplifiedDOM(browser);

		assert.include(simplified, `scroll-enabled: "container enabled"`);
		assert.include(
			simplified,
			`scroll-enabled scrollable: "container scrolling"`,
		);
		const normalLine = simplified
			.split("\n")
			.find((line) => line.includes(`"container normal"`));
		assert.isString(normalLine);
		assert.notInclude(normalLine ?? "", "scroll-enabled");
		assert.notInclude(normalLine ?? "", "scrollable");
	});
});
