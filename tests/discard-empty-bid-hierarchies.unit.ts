import { assert } from "chai";
import { describe, it } from "mocha";
import { getSimplifiedDOM } from "../src/browser/simplify-dom.js";
import { discardEmptyBidHierarchies } from "../src/browser/simplify-dom-utils/discard-empty-bid-hierarchies.js";
import type { SimplifiedNode } from "../src/browser/simplify-dom-utils/simplified-node.js";

function node(
	tag: string,
	params: Partial<SimplifiedNode> = {},
): SimplifiedNode {
	return {
		tag,
		attrs: [],
		text: "",
		children: [],
		isHidden: false,
		isInteractive: false,
		...params,
	};
}

function createFlagIntegrationSnapshot(): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"DIV",
		"BUTTON",
		"STRONG",
		"data-bid",
		"empty-root",
		"empty-button",
		"semantic-root",
		"semantic-leaf",
		"empty-sibling",
		"Headline",
		"block",
		"visible",
		"1",
		"default",
		"hidden",
		"none",
		"",
		"https://example.com/",
	];
	const elementNodeIndexes = [1, 2, 3, 4, 5, 6, 8];

	return {
		documents: [
			{
				documentURL: 20,
				title: 19,
				baseURL: 20,
				contentLanguage: 19,
				encodingName: 19,
				publicId: 19,
				systemId: 19,
				frameId: 19,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 3, 2, 5, 6, 5],
					nodeType: [9, 1, 1, 1, 1, 1, 1, 3, 1],
					nodeName: [0, 1, 2, 3, 4, 3, 5, 0, 4],
					nodeValue: [19, 19, 19, 19, 19, 19, 19, 12, 19],
					attributes: [
						[],
						[],
						[],
						[6, 7],
						[6, 8],
						[6, 9],
						[6, 10],
						[],
						[6, 11],
					],
				},
				layout: {
					nodeIndex: elementNodeIndexes,
					styles: elementNodeIndexes.map(() => [
						13, 14, 15, 16, 17, 17, 18,
					]),
					bounds: elementNodeIndexes.map(() => [0, 0, 200, 40]),
					text: elementNodeIndexes.map(() => 19),
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

describe("discard-empty-bid-hierarchies", () => {
	it("removes a fully empty bid hierarchy, including structural wrappers", () => {
		const tree = node("listitem", {
			attrs: [["ncid", "!5t"]],
			children: [
				node("div", {
					attrs: [["bid", "ky,kx"]],
					children: [
						node("div", { attrs: [["bid", "ku,kt"]] }),
						node("button", {
							attrs: [["bid", "kw,kv"]],
							isInteractive: true,
						}),
					],
				}),
			],
		});

		assert.isNull(discardEmptyBidHierarchies(tree));
	});

	it("retains semantic sibling paths and removes empty siblings independently", () => {
		const emptySibling = node("div", { attrs: [["bid", "1oj"]] });
		const emptyNestedSibling = node("button", {
			attrs: [["bid", "2c"]],
			isInteractive: true,
		});
		const firstSemanticPath = node("div", {
			attrs: [["bid", "1ok"]],
			children: [
				node("strong", {
					attrs: [["bid", "1ol"]],
					text: "Cher Lloyd likes post",
				}),
			],
		});
		const secondSemanticPath = node("div", {
			attrs: [["bid", "2a"]],
			children: [
				node("span", {
					attrs: [
						["bid", "2b"],
						["title", "Related story"],
					],
				}),
			],
		});
		const semanticHierarchy = node("div", {
			attrs: [["bid", "1om"]],
			children: [
				firstSemanticPath,
				emptyNestedSibling,
				secondSemanticPath,
			],
		});
		const tree = node("html", {
			children: [emptySibling, semanticHierarchy],
		});

		const retained = discardEmptyBidHierarchies(tree);
		assert.strictEqual(retained, tree);
		assert.deepEqual(tree.children, [semanticHierarchy]);
		assert.deepEqual(semanticHierarchy.children, [
			firstSemanticPath,
			secondSemanticPath,
		]);
	});

	it("keeps non-ID metadata and viewport or scroll markers", () => {
		const hrefOnly = node("a", {
			attrs: [
				["bid", "href"],
				["href", ""],
			],
		});
		const outsideViewport = node("div", {
			attrs: [["bid", "outside"]],
			outsideViewport: { direction: "below", scrollDeltaY: 250 },
		});
		const scrollEnabled = node("div", {
			attrs: [["bid", "enabled"]],
			scrollEnabled: true,
		});
		const scrollable = node("div", {
			attrs: [["bid", "scrollable"]],
			scrollable: true,
		});
		const whitespaceOnly = node("div", {
			attrs: [["bid", "whitespace"]],
			text: "  \n\t ",
			couldBeHidden: true,
			noClickAllowed: true,
		});
		const tree = node("body", {
			children: [
				hrefOnly,
				outsideViewport,
				scrollEnabled,
				scrollable,
				whitespaceOnly,
			],
		});

		assert.strictEqual(discardEmptyBidHierarchies(tree), tree);
		assert.deepEqual(tree.children, [
			hrefOnly,
			outsideViewport,
			scrollEnabled,
			scrollable,
		]);
	});

	it("leaves output unchanged when disabled and prunes it by default", async () => {
		const browser = {
			DOMSnapshot: {
				captureSnapshot: async () => createFlagIntegrationSnapshot(),
			},
		} as any;
		const unpruned = await getSimplifiedDOM(browser, {
			discardEmptyBids: false,
		});
		assert.include(unpruned, "empty-root");
		assert.include(unpruned, "empty-button");
		assert.include(unpruned, "empty-sibling");
		assert.include(unpruned, "Headline");

		const pruned = await getSimplifiedDOM(browser);
		assert.notInclude(pruned, "empty-root");
		assert.notInclude(pruned, "empty-button");
		assert.notInclude(pruned, "empty-sibling");
		assert.include(pruned, "semantic-root");
		assert.include(pruned, "semantic-leaf");
		assert.include(pruned, "Headline");
	});
});
