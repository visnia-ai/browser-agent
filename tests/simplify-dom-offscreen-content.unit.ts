import { assert } from "chai";
import { describe, it } from "mocha";
import { extractValidBids } from "../src/browser/simplify-dom-utils/extract-valid-bids.js";
import { getExecutorSystemBase } from "../src/agents/prompts.js";
import { getSimplifiedDOM } from "../src/browser/simplify-dom.js";
import { mergeSingleChildBidChains } from "../src/browser/simplify-dom-utils/merge-single-child-bid-chains.js";
import { serializeSimplifiedNode } from "../src/browser/simplify-dom-utils/serialize-simplified-node.js";
import type { SimplifiedNode } from "../src/browser/simplify-dom-utils/simplified-node.js";
import {
	minifySimplifiedDOM,
	unminifySimplifiedDOM,
} from "../src/browser/simplified-dom-minifier.js";

function createOffscreenSnapshot(): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"DIV",
		"SECTION",
		"block",
		"visible",
		"1",
		"default",
		"hidden",
		"",
		"below content",
		"above content",
		"horizontal content",
		"nested below content",
		"data-bid",
		"above",
	];
	const layoutNodeIndexes = [1, 2, 3, 4, 6, 8, 10, 11];
	const boundsByNode = new Map<number, number[]>([
		[1, [0, 0, 1000, 1200]],
		[2, [0, 0, 1000, 1200]],
		[3, [0, 0, 1000, 1200]],
		[4, [0, 650, 100, 40]],
		[6, [0, -300, 100, 40]],
		[8, [5000, 150, 100, 40]],
		[10, [0, 700, 200, 200]],
		[11, [0, 720, 100, 40]],
	]);

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
					parentIndex: [-1, 0, 1, 2, 3, 4, 3, 6, 3, 8, 3, 10, 11],
					nodeType: [9, 1, 1, 1, 1, 3, 1, 3, 1, 3, 1, 1, 3],
					nodeName: [0, 1, 2, 3, 3, 0, 3, 0, 3, 0, 4, 3, 0],
					nodeValue: [
						10, 10, 10, 10, 10, 11, 10, 12, 10, 13, 10, 10, 14,
					],
					attributes: [
						[],
						[],
						[],
						[],
						[],
						[],
						[15, 16],
						[],
						[],
						[],
						[],
						[],
						[],
					],
					backendNodeId: [
						0, 101, 102, 103, 104, 0, 106, 0, 108, 0, 110, 111, 0,
					],
				},
				layout: {
					nodeIndex: layoutNodeIndexes,
					bounds: layoutNodeIndexes.map((nodeIndex) =>
						boundsByNode.get(nodeIndex),
					),
					styles: layoutNodeIndexes.map(() => [5, 6, 7, 8, 9, 9, 10]),
					text: layoutNodeIndexes.map(() => 10),
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

function createOffscreenIframeSnapshot(): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"DIV",
		"IFRAME",
		"P",
		"block",
		"visible",
		"1",
		"default",
		"hidden",
		"",
		"visible main content",
		"hidden iframe content",
	];
	const styles = [6, 7, 8, 9, 10, 10, 11];
	const textBoxes = {
		layoutIndex: [],
		bounds: [],
		start: [],
		length: [],
	};
	return {
		documents: [
			{
				documentURL: 11,
				title: 11,
				baseURL: 11,
				contentLanguage: 11,
				encodingName: 11,
				publicId: 11,
				systemId: 11,
				frameId: 11,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 3, 2],
					nodeType: [9, 1, 1, 1, 3, 1],
					nodeName: [0, 1, 2, 3, 0, 4],
					nodeValue: [11, 11, 11, 11, 12, 11],
					attributes: [[], [], [], [], [], []],
					backendNodeId: [0, 101, 102, 103, 0, 105],
					contentDocumentIndex: { index: [5], value: [1] },
				},
				layout: {
					nodeIndex: [1, 2, 3, 5],
					bounds: [
						[0, 0, 1000, 1000],
						[0, 0, 1000, 1000],
						[0, 100, 200, 40],
						[0, 650, 300, 200],
					],
					styles: [styles, styles, styles, styles],
					text: [11, 11, 11, 11],
					stackingContexts: { index: [] },
				},
				textBoxes,
			},
			{
				documentURL: 11,
				title: 11,
				baseURL: 11,
				contentLanguage: 11,
				encodingName: 11,
				publicId: 11,
				systemId: 11,
				frameId: 11,
				scrollOffsetY: 0,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 3],
					nodeType: [9, 1, 1, 1, 3],
					nodeName: [0, 1, 2, 5, 0],
					nodeValue: [11, 11, 11, 11, 13],
					attributes: [[], [], [], [], []],
					backendNodeId: [0, 201, 202, 203, 0],
				},
				layout: {
					nodeIndex: [1, 2, 3],
					bounds: [
						[0, 0, 300, 200],
						[0, 0, 300, 200],
						[0, 0, 200, 40],
					],
					styles: [styles, styles, styles],
					text: [11, 11, 11],
					stackingContexts: { index: [] },
				},
				textBoxes,
			},
		],
		strings,
	};
}

function createMockBrowser(
	params: { metricsFail?: boolean; snapshot?: any } = {},
): {
	browser: any;
	getLayoutMetricsCalls: () => number;
	stampedBids: Array<{ backendNodeId: number; bid: string }>;
} {
	let layoutMetricsCalls = 0;
	const stampedBids: Array<{ backendNodeId: number; bid: string }> = [];
	let pendingBackendNodeIds: number[] = [];
	return {
		browser: {
			Page: {
				getLayoutMetrics: async () => {
					layoutMetricsCalls++;
					if (params.metricsFail)
						throw new Error("metrics unavailable");
					return {
						cssVisualViewport: {
							pageY: 100,
							clientHeight: 200,
						},
					};
				},
			},
			DOMSnapshot: {
				captureSnapshot: async () =>
					params.snapshot ?? createOffscreenSnapshot(),
			},
			DOM: {
				getDocument: async () => ({}),
				pushNodesByBackendIdsToFrontend: async ({
					backendNodeIds,
				}: {
					backendNodeIds: number[];
				}) => {
					pendingBackendNodeIds = backendNodeIds;
					return { nodeIds: backendNodeIds.map((id) => id + 1000) };
				},
				setAttributeValue: async ({
					nodeId,
					value,
				}: {
					nodeId: number;
					value: string;
				}) => {
					const index = pendingBackendNodeIds.findIndex(
						(id) => id + 1000 === nodeId,
					);
					stampedBids.push({
						backendNodeId: pendingBackendNodeIds[index],
						bid: value,
					});
				},
			},
		},
		getLayoutMetricsCalls: () => layoutMetricsCalls,
		stampedBids,
	};
}

describe("simplify-dom offscreen content", () => {
	it("leaves the DOM unchanged and avoids viewport metrics when disabled", async () => {
		const mock = createMockBrowser();
		const simplified = await getSimplifiedDOM(mock.browser);

		assert.include(simplified, "below content");
		assert.include(simplified, "above content");
		assert.include(simplified, "nested below content");
		assert.strictEqual(mock.getLayoutMetricsCalls(), 0);
	});

	it("replaces maximal vertically distant subtrees with scroll placeholders", async () => {
		const mock = createMockBrowser();
		const simplified = await getSimplifiedDOM(mock.browser, {
			hideOffscreenContent: true,
		});

		assert.notInclude(simplified, "below content");
		assert.notInclude(simplified, "above content");
		assert.notInclude(simplified, "nested below content");
		assert.include(simplified, "horizontal content");
		assert.match(
			simplified,
			/content-hidden-outside-viewport bid="[^"]+" scroll-delta-y="350"/,
		);
		assert.include(
			simplified,
			'content-hidden-outside-viewport bid="above" scroll-delta-y="-360"',
		);
		assert.match(
			simplified,
			/content-hidden-outside-viewport bid="[^"]+" scroll-delta-y="400"/,
		);
		assert.lengthOf(
			simplified
				.split("\n")
				.filter((line) =>
					line.includes("content-hidden-outside-viewport"),
				),
			3,
		);
		assert.isNotEmpty(mock.stampedBids);

		const markerBid = simplified.match(
			/content-hidden-outside-viewport bid="([^"]+)"/,
		)?.[1];
		assert.isString(markerBid);
		assert.include(extractValidBids(simplified), markerBid);
		assert.strictEqual(
			unminifySimplifiedDOM(minifySimplifiedDOM(simplified)),
			simplified,
		);
	});

	it("falls back to the full DOM when viewport metrics are unavailable", async () => {
		const mock = createMockBrowser({ metricsFail: true });
		const simplified = await getSimplifiedDOM(mock.browser, {
			hideOffscreenContent: true,
		});

		assert.include(simplified, "below content");
		assert.notInclude(simplified, "content-hidden-outside-viewport");
	});

	it("retains content touching the overscan boundaries", async () => {
		const snapshot = createOffscreenSnapshot();
		const layout = snapshot.documents[0].layout;
		layout.bounds[layout.nodeIndex.indexOf(4)] = [0, 400, 100, 40];
		layout.bounds[layout.nodeIndex.indexOf(6)] = [0, -40, 100, 40];
		const mock = createMockBrowser({ snapshot });
		const simplified = await getSimplifiedDOM(mock.browser, {
			hideOffscreenContent: true,
		});

		assert.include(simplified, "below content");
		assert.include(simplified, "above content");
	});

	it("retains a visible descendant of an otherwise offscreen parent", async () => {
		const snapshot = createOffscreenSnapshot();
		const layout = snapshot.documents[0].layout;
		layout.bounds[layout.nodeIndex.indexOf(11)] = [0, 150, 100, 40];
		const mock = createMockBrowser({ snapshot });
		const simplified = await getSimplifiedDOM(mock.browser, {
			hideOffscreenContent: true,
		});

		assert.include(simplified, "nested below content");
		assert.notInclude(simplified, 'scroll-delta-y="400"');
	});

	it("translates iframe descendants into top-level viewport coordinates", async () => {
		const mock = createMockBrowser({
			snapshot: createOffscreenIframeSnapshot(),
		});
		const simplified = await getSimplifiedDOM(mock.browser, {
			hideOffscreenContent: true,
		});

		assert.include(simplified, "visible main content");
		assert.notInclude(simplified, "hidden iframe content");
		assert.match(
			simplified,
			/content-hidden-outside-viewport bid="[^"]+" scroll-delta-y="350"/,
		);
		assert.lengthOf(
			simplified
				.split("\n")
				.filter((line) =>
					line.includes("content-hidden-outside-viewport"),
				),
			1,
		);
	});

	it("does not leak retired simplified-DOM markers into the projection executor prompt", () => {
		assert.notInclude(
			getExecutorSystemBase(),
			"Nodes marked content-hidden-outside-viewport",
		);

		const prompt = getExecutorSystemBase();
		assert.notInclude(
			prompt,
			"Nodes marked content-hidden-outside-viewport",
		);
		assert.notInclude(prompt, "scroll-delta-y");
		assert.include(prompt, "opaque ref");
	});

	it("serializes placeholders exactly and preserves them during bid cleanup", () => {
		const marker: SimplifiedNode = {
			tag: "content-hidden-outside-viewport",
			attrs: [["bid", "child"]],
			text: "omitted",
			children: [],
			isHidden: false,
			isInteractive: false,
			outsideViewport: { direction: "below", scrollDeltaY: 275 },
		};
		const parent: SimplifiedNode = {
			tag: "div",
			attrs: [["bid", "parent"]],
			text: "",
			children: [marker],
			isHidden: false,
			isInteractive: true,
		};

		assert.strictEqual(
			serializeSimplifiedNode(marker, 0),
			'content-hidden-outside-viewport bid="child" scroll-delta-y="275"',
		);
		assert.strictEqual(
			mergeSingleChildBidChains(parent).children[0],
			marker,
		);
	});
});
