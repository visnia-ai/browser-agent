import { assert } from "chai";
import { describe, it } from "mocha";
import { getSimplifiedDOM } from "../src/browser/simplify-dom.js";

function makeSnapshotWithAnchor(
	documentUrl: string,
	href = "/wiki/Google",
): any {
	const strings = [
		"#document",
		"HTML",
		"BODY",
		"A",
		"href",
		href,
		"data-bid",
		"abc",
		"Google",
		"block",
		"visible",
		"1",
		"",
		documentUrl,
		"page",
	];

	const layout = {
		nodeIndex: [1, 2, 3],
		styles: [
			[9, 10, 11],
			[9, 10, 11],
			[9, 10, 11],
		],
		bounds: [
			[0, 0, 120, 40],
			[0, 0, 120, 40],
			[0, 0, 120, 40],
		],
		text: [12, 12, 12],
		stackingContexts: { index: [] },
	};

	return {
		documents: [
			{
				documentURL: 13,
				title: 12,
				baseURL: 13,
				contentLanguage: 12,
				encodingName: 12,
				publicId: 12,
				systemId: 12,
				frameId: 12,
				nodes: {
					parentIndex: [-1, 0, 1, 2, 3, 2],
					nodeType: [9, 1, 1, 1, 3, 3],
					nodeName: [0, 1, 2, 3, 0, 0],
					nodeValue: [12, 12, 12, 12, 8, 14],
					attributes: [[], [], [], [4, 5, 6, 7], [], []],
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

describe("simplify-dom wikipedia href normalization", () => {
	it("normalizes wikipedia hrefs while preserving anchors", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithAnchor("https://en.wikipedia.org/wiki/Google"),
		);
		const simplified = await getSimplifiedDOM(browser, {
			omitHrefs: false,
		});
		assert.include(simplified, `href=""`);
		assert.notInclude(simplified, `href="/wiki/Google"`);
		assert.include(simplified, `bid="abc"`);
		assert.include(simplified, "Google");
	});

	it("preserves the raw href on wikipedia pages when requested", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithAnchor("https://en.wikipedia.org/wiki/Google"),
		);
		const simplified = await getSimplifiedDOM(browser, {
			omitHrefs: false,
			preserveFullHrefs: true,
		});
		assert.include(simplified, `href="/wiki/Google"`);
	});

	it("keeps href value on non-wikipedia pages", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithAnchor("https://example.com/page"),
		);
		const simplified = await getSimplifiedDOM(browser, {
			omitHrefs: false,
		});
		assert.include(simplified, `href="/wiki/Google"`);
	});

	it("removes hrefs through the explicit serializer option", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithAnchor("https://example.com/page"),
		);

		const simplified = await getSimplifiedDOM(browser, { omitHrefs: true });

		assert.include(simplified, `a bid="abc"`);
		assert.include(simplified, "Google");
		assert.notInclude(simplified, "href");
		assert.notInclude(simplified, "/wiki/Google");
	});

	it("normalizes javascript hrefs", async () => {
		const browser = createMockBrowser(
			makeSnapshotWithAnchor(
				"https://example.com/page",
				"javascript: void(0)",
			),
		);
		const simplified = await getSimplifiedDOM(browser, {
			omitHrefs: false,
		});
		assert.include(simplified, `href=""`);
		assert.notInclude(simplified, "javascript");
	});

	it("preserves complete raw href values for extraction", async () => {
		const hrefs = [
			`https://example.com/${"a".repeat(180)}?query=kept#fragment`,
			"//cdn.example.com/product",
			"/root-relative",
			"path-relative",
			"?page=2",
			"#details",
			"javascript:void(0)",
			"mailto:sales@example.com",
		];

		for (const href of hrefs) {
			const simplified = await getSimplifiedDOM(
				createMockBrowser(
					makeSnapshotWithAnchor("https://example.com/catalog", href),
				),
				{ omitHrefs: false, preserveFullHrefs: true },
			);
			assert.include(simplified, `href="${href}"`);
		}
	});
});
