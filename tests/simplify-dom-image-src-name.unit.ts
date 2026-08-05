import { assert } from "chai";
import { describe, it } from "mocha";
import { getSimplifiedDOM } from "../src/browser/simplify-dom.js";

function makeSnapshotWithImage(srcValue: string, clickable = false): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"IMG",
		"src",
		srcValue,
		"role",
		"button",
		"block",
		"visible",
		"1",
		"",
		"page",
	];

	const layout = {
		nodeIndex: [1, 2, 3],
		styles: [
			[6, 7, 8],
			[6, 7, 8],
			[6, 7, 8],
		],
		bounds: [
			[0, 0, 120, 40],
			[0, 0, 120, 40],
			[0, 0, 120, 40],
		],
		text: [9, 9, 9],
		stackingContexts: { index: [] },
	};

	return {
		documents: [
			{
				documentURL: 9,
				title: 9,
				baseURL: 9,
				contentLanguage: 9,
				encodingName: 9,
				publicId: 9,
				systemId: 9,
				frameId: 9,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 2],
					nodeType: [9, 1, 1, 1, 3],
					nodeName: [0, 1, 2, 3, 0],
					nodeValue: [9, 9, 9, 9, 12],
					attributes: [
						[],
						[],
						[],
						clickable ? [4, 5, 6, 7] : [4, 5],
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

function makeSnapshotWithImageUnderClickableParent(srcValue: string): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"DIV",
		"IMG",
		"src",
		srcValue,
		"role",
		"button",
		"block",
		"visible",
		"1",
		"",
		"page",
	];

	const layout = {
		nodeIndex: [1, 2, 3, 4],
		styles: [
			[9, 10, 11],
			[9, 10, 11],
			[9, 10, 11],
			[9, 10, 11],
		],
		bounds: [
			[0, 0, 120, 40],
			[0, 0, 120, 40],
			[0, 0, 120, 40],
			[0, 0, 120, 40],
		],
		text: [12, 12, 12, 12],
		stackingContexts: { index: [] },
	};

	return {
		documents: [
			{
				documentURL: 12,
				title: 12,
				baseURL: 12,
				contentLanguage: 12,
				encodingName: 12,
				publicId: 12,
				systemId: 12,
				frameId: 12,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 3, 2],
					nodeType: [9, 1, 1, 1, 1, 3],
					nodeName: [0, 1, 2, 3, 4, 0],
					nodeValue: [12, 12, 12, 12, 12, 13],
					attributes: [[], [], [], [7, 8], [5, 6], []],
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

function makeSnapshotWithBackgroundImage(
	backgroundImageValue: string,
	clickable = false,
): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"DIV",
		"role",
		"button",
		"block",
		"visible",
		"1",
		"",
		backgroundImageValue,
		"page",
	];

	const layout = {
		nodeIndex: [1, 2, 3],
		styles: [
			[6, 7, 8, 9, 9, 9, 9],
			[6, 7, 8, 9, 9, 9, 9],
			[6, 7, 8, 9, 9, 9, 10],
		],
		bounds: [
			[0, 0, 120, 40],
			[0, 0, 120, 40],
			[0, 0, 120, 40],
		],
		text: [9, 9, 9],
		stackingContexts: { index: [] },
	};

	return {
		documents: [
			{
				documentURL: 9,
				title: 9,
				baseURL: 9,
				contentLanguage: 9,
				encodingName: 9,
				publicId: 9,
				systemId: 9,
				frameId: 9,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 2],
					nodeType: [9, 1, 1, 1, 3],
					nodeName: [0, 1, 2, 3, 0],
					nodeValue: [9, 9, 9, 9, 11],
					attributes: [[], [], [], clickable ? [4, 5] : [], []],
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

function makeSnapshotWithBackgroundImageUnderClickableParent(
	backgroundImageValue: string,
): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"DIV",
		"role",
		"button",
		"block",
		"visible",
		"1",
		"",
		backgroundImageValue,
		"page",
	];

	const layout = {
		nodeIndex: [1, 2, 3, 4],
		styles: [
			[6, 7, 8, 9, 9, 9, 9],
			[6, 7, 8, 9, 9, 9, 9],
			[6, 7, 8, 9, 9, 9, 9],
			[6, 7, 8, 9, 9, 9, 10],
		],
		bounds: [
			[0, 0, 120, 40],
			[0, 0, 120, 40],
			[0, 0, 120, 40],
			[0, 0, 120, 40],
		],
		text: [9, 9, 9, 9],
		stackingContexts: { index: [] },
	};

	return {
		documents: [
			{
				documentURL: 9,
				title: 9,
				baseURL: 9,
				contentLanguage: 9,
				encodingName: 9,
				publicId: 9,
				systemId: 9,
				frameId: 9,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 3, 2],
					nodeType: [9, 1, 1, 1, 1, 3],
					nodeName: [0, 1, 2, 3, 3, 0],
					nodeValue: [9, 9, 9, 9, 9, 11],
					attributes: [[], [], [], [4, 5], [], []],
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

function createMockBrowser(snapshot: any): any {
	return {
		DOMSnapshot: {
			captureSnapshot: async () => snapshot,
		},
	};
}

describe("simplify-dom image src filename extraction", () => {
	it("includes extracted image filename when under 50 chars", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithImage(
				"https://cdn.example.com/assets/icons/logo.png?v=3",
				true,
			),
		);
		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `img="logo.png"`);
		assert.notInclude(simplified, `src="logo.png"`);
	});

	it("omits extracted image filename when 50 chars or longer", async () => {
		const longName = `${"a".repeat(46)}.png`;
		const browser = createMockBrowser(
			makeSnapshotWithImage(
				`https://cdn.example.com/assets/${longName}`,
				true,
			),
		);
		const simplified = await getSimplifiedDOM(browser);
		assert.notInclude(simplified, `img="${longName}"`);
		assert.notInclude(simplified, `src="${longName}"`);
	});

	it("omits extracted image filename for non-clickable img", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithImage(
				"https://cdn.example.com/assets/icons/logo.png?v=3",
			),
		);
		const simplified = await getSimplifiedDOM(browser);
		assert.notInclude(simplified, `img="logo.png"`);
		assert.notInclude(simplified, `src="logo.png"`);
	});

	it("keeps img tag and extracted filename under clickable parent hierarchy", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithImageUnderClickableParent(
				"https://cdn.example.com/assets/icons/logo.png?v=3",
			),
		);
		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `img="logo.png"`);
		assert.notInclude(simplified, `src="logo.png"`);
	});

	it("includes background-image filename as img attr in clickable hierarchy", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithBackgroundImage(
				`url("https://cdn.example.com/assets/icons/logo.png?v=3")`,
				true,
			),
		);
		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `img="logo.png"`);
		assert.notInclude(
			simplified,
			`img="https://cdn.example.com/assets/icons/logo.png?v=3"`,
		);
	});

	it("omits background-image filename when 30 chars or longer", async () => {
		const longName = `${"a".repeat(26)}.png`;
		const browser = createMockBrowser(
			makeSnapshotWithBackgroundImage(
				`url("https://cdn.example.com/assets/${longName}")`,
				true,
			),
		);
		const simplified = await getSimplifiedDOM(browser);
		assert.notInclude(simplified, `img="${longName}"`);
	});

	it("omits background-image filename for non-clickable hierarchy", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithBackgroundImage(
				`url("https://cdn.example.com/assets/icons/logo.png?v=3")`,
				false,
			),
		);
		const simplified = await getSimplifiedDOM(browser);
		assert.notInclude(simplified, `img="logo.png"`);
	});

	it("includes background-image filename for non-interactive descendants under clickable parent", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithBackgroundImageUnderClickableParent(
				`url(https://cdn.example.com/assets/icons/logo.png), linear-gradient(#fff, #000)`,
			),
		);
		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `img="logo.png"`);
	});

	it("uses the first valid background-image url candidate", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithBackgroundImage(
				`url(""), url("https://cdn.example.com/assets/icons/logo.png"), linear-gradient(#fff, #000)`,
				true,
			),
		);
		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `img="logo.png"`);
	});
});
