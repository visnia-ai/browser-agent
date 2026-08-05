import { assert } from "chai";
import { describe, it } from "mocha";
import { getSimplifiedDOM } from "../src/browser/simplify-dom.js";
import { runFinalTransparentWrapperHoist } from "../src/browser/simplify-dom-utils/final-hoist-transparent-same-tag-wrappers.js";
import type { SimplifiedNode } from "../src/browser/simplify-dom-utils/simplified-node.js";

function makeContainerSnapshot(): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"DIV",
		"SPAN",
		"SECTION",
		"P",
		"data-bid",
		"existing",
		"data-nonclickableid",
		"!a",
		"!leaf",
		"Bid child",
		"First",
		"Second",
		"block",
		"visible",
		"1",
		"",
		"https://example.com/",
	];
	const layoutNodeIndexes = [1, 2, 3, 4, 6, 7, 9];
	const layout = {
		nodeIndex: layoutNodeIndexes,
		styles: layoutNodeIndexes.map(() => [15, 16, 17]),
		bounds: layoutNodeIndexes.map(() => [0, 0, 120, 40]),
		text: layoutNodeIndexes.map(() => 18),
		stackingContexts: { index: [] },
	};

	return {
		documents: [
			{
				documentURL: 19,
				title: 18,
				baseURL: 19,
				contentLanguage: 18,
				encodingName: 18,
				publicId: 18,
				systemId: 18,
				frameId: 18,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 3, 4, 2, 6, 7, 6, 9],
					nodeType: [9, 1, 1, 1, 1, 3, 1, 1, 3, 1, 3],
					nodeName: [0, 1, 2, 3, 4, 0, 5, 6, 0, 6, 0],
					nodeValue: [18, 18, 18, 18, 18, 12, 18, 18, 13, 18, 14],
					attributes: [
						[],
						[],
						[],
						[7, 8],
						[],
						[],
						[9, 10],
						[9, 11],
						[],
						[],
						[],
					],
				},
				layout,
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

describe("simplify-dom non-clickable IDs", () => {
	it("does not let ncid handles prevent transparent wrapper cleanup", () => {
		const leaf: SimplifiedNode = {
			tag: "span",
			attrs: [],
			text: "Result",
			children: [],
			isHidden: false,
			isInteractive: false,
		};
		const wrapper: SimplifiedNode = {
			tag: "div",
			attrs: [["ncid", "!wrapper"]],
			text: "",
			children: [leaf],
			isHidden: false,
			isInteractive: false,
		};
		const root: SimplifiedNode = {
			...wrapper,
			attrs: [["ncid", "!root"]],
			children: [wrapper],
		};

		assert.strictEqual(runFinalTransparentWrapperHoist(root), leaf);
	});

	it("adds ncid only to bid-free containers with element children", async () => {
		const simplified = await getSimplifiedDOM(
			{
				DOMSnapshot: {
					captureSnapshot: async () => makeContainerSnapshot(),
				},
			} as any,
			{ includeNonClickableIds: true },
		);

		assert.match(simplified, /bid="existing"/);
		assert.notMatch(simplified, /bid="existing"[^\n]*ncid=/);
		assert.match(simplified, /ncid="!a"/);
		assert.notInclude(simplified, `ncid="!leaf"`);
	});
});
