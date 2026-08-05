import { assert } from "chai";
import { describe, it } from "mocha";
import { getSimplifiedDOM } from "../src/browser/simplify-dom.js";

function makeSnapshotWithIframeContent(iframeName = "iframeResult"): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"IFRAME",
		"name",
		"iframeResult",
		"P",
		"inside iframe",
		"block",
		"visible",
		"1",
		"frame-main",
		"frame-iframe",
		"",
		"outside main",
	];
	const iframeNameIndex = strings.push(iframeName) - 1;

	const layoutForNodes = (nodeIndex: number[]) => ({
		nodeIndex,
		styles: nodeIndex.map(() => [8, 9, 10]),
		bounds: nodeIndex.map(() => [0, 0, 120, 40]),
		text: nodeIndex.map(() => 13),
		stackingContexts: { index: [] },
	});

	const textBoxes = {
		layoutIndex: [],
		bounds: [],
		start: [],
		length: [],
	};

	const mainDocument = {
		documentURL: 13,
		title: 13,
		baseURL: 13,
		contentLanguage: 13,
		encodingName: 13,
		publicId: 13,
		systemId: 13,
		frameId: 11,
		nodes: {
			parentIndex: [-1, 0, 1, 2, 2, 4],
			nodeType: [9, 1, 1, 1, 1, 3],
			nodeName: [0, 1, 2, 3, 6, 0],
			nodeValue: [13, 13, 13, 13, 13, 14],
			attributes: [[], [], [], [4, iframeNameIndex], [], []],
			contentDocumentIndex: { index: [3], value: [1] },
		},
		layout: layoutForNodes([1, 2, 3, 4]),
		textBoxes,
	};

	const iframeDocument = {
		documentURL: 13,
		title: 13,
		baseURL: 13,
		contentLanguage: 13,
		encodingName: 13,
		publicId: 13,
		systemId: 13,
		frameId: 12,
		nodes: {
			parentIndex: [-1, 0, 1, 2, 3],
			nodeType: [9, 1, 1, 1, 3],
			nodeName: [0, 1, 2, 6, 0],
			nodeValue: [13, 13, 13, 13, 7],
			attributes: [[], [], [], [], []],
		},
		layout: layoutForNodes([1, 2, 3]),
		textBoxes,
	};

	return {
		documents: [mainDocument, iframeDocument],
		strings,
	};
}

function createMockBrowser(snapshot: any): any {
	return {
		DOMSnapshot: {
			captureSnapshot: async () => snapshot,
		},
	};
}

describe("simplify-dom iframe traversal", () => {
	it("traverses iframe document content", async () => {
		const snapshot = makeSnapshotWithIframeContent();
		const browser = createMockBrowser(snapshot);
		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `iframe name="iframeResult":`);
		assert.include(simplified, `p: "inside iframe"`);
	});

	it("removes oversized iframe attribute values", async () => {
		const longName = "x".repeat(1001);
		const snapshot = makeSnapshotWithIframeContent(longName);
		const browser = createMockBrowser(snapshot);
		const simplified = await getSimplifiedDOM(browser);
		assert.notInclude(simplified, `name="${longName}"`);
		assert.include(simplified, `p: "inside iframe"`);
	});
});
