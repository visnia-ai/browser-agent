import { assert } from "chai";
import { describe, it } from "mocha";
import { getSimplifiedDOM } from "../src/browser/simplify-dom.js";

function createSnapshotWithoutDocuments(): any {
	return {
		documents: [],
		strings: [],
	};
}

function createSnapshotWithoutBody(): any {
	const strings = ["#document", "HTML", ""];
	return {
		documents: [
			{
				documentURL: 2,
				title: 2,
				baseURL: 2,
				contentLanguage: 2,
				encodingName: 2,
				publicId: 2,
				systemId: 2,
				frameId: 2,
				nodes: {
					parentIndex: [-1, 0],
					nodeType: [9, 1],
					nodeName: [0, 1],
					nodeValue: [2, 2],
					attributes: [[], []],
				},
				layout: {
					nodeIndex: [1],
					styles: [[2, 2, 2]],
					bounds: [[0, 0, 120, 40]],
					text: [2],
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

function createFallbackMockBrowser(params: {
	snapshot?: any;
	runtimeValue?: {
		url?: string;
		title?: string;
		contentType?: string;
		viewerTags?: string[];
		bodyText?: string;
	};
	resourceUrl?: string;
	resourceContent?: string;
	resourceBase64?: boolean;
}): any {
	const runtimeValue = params.runtimeValue ?? {};
	const resourceUrl = params.resourceUrl ?? runtimeValue.url ?? "";
	return {
		DOMSnapshot: {
			captureSnapshot: async () =>
				params.snapshot ?? createSnapshotWithoutDocuments(),
		},
		Runtime: {
			evaluate: async () => ({ result: { value: runtimeValue } }),
		},
		Page: {
			getResourceTree: async () => ({
				frameTree: {
					frame: {
						id: "frame-1",
						url: resourceUrl,
					},
				},
			}),
			getResourceContent: async () => ({
				content: params.resourceContent ?? "",
				base64Encoded: params.resourceBase64 === true,
			}),
		},
	};
}

describe("simplify-dom non-html fallback", () => {
	it("returns a non-empty synthetic snapshot when DOMSnapshot has no documents", async () => {
		const browser = createFallbackMockBrowser({
			snapshot: createSnapshotWithoutDocuments(),
			runtimeValue: {
				url: "http://127.0.0.1:1111/test.pdf",
				contentType: "application/pdf",
				viewerTags: ["embed"],
			},
		});

		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `file-view kind="non-html-fallback"`);
		assert.include(simplified, `content-type="application/pdf"`);
		assert.include(simplified, `downloadable="true"`);
	});

	it("returns fallback when root document has no BODY node", async () => {
		const browser = createFallbackMockBrowser({
			snapshot: createSnapshotWithoutBody(),
			runtimeValue: {
				url: "http://127.0.0.1:1111/data.bin",
				contentType: "application/octet-stream",
			},
		});

		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `kind="non-html-fallback"`);
		assert.include(simplified, `downloadable="true"`);
	});

	it("includes textual preview for JSON-like responses", async () => {
		const browser = createFallbackMockBrowser({
			runtimeValue: {
				url: "http://127.0.0.1:1111/test_data.json",
				contentType: "application/json",
				title: "json page",
			},
			resourceContent: `{"testdata":[{"domain_url":"example.com"}]}`,
		});

		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `content-type="application/json"`);
		assert.match(simplified, /preview:\s*".*testdata.*domain_url.*"/);
		assert.notInclude(simplified, `metadata:`);
	});

	it("includes metadata for non-text binary responses", async () => {
		const browser = createFallbackMockBrowser({
			runtimeValue: {
				url: "http://127.0.0.1:1111/image.jpg",
				contentType: "image/jpeg",
				viewerTags: ["img"],
			},
			resourceContent: "AAECAwQF",
			resourceBase64: true,
		});

		const simplified = await getSimplifiedDOM(browser);
		assert.include(simplified, `content-type="image/jpeg"`);
		assert.include(simplified, `metadata:`);
		assert.notInclude(simplified, `preview:`);
	});

	it("maps downloadability to true, false, and unknown", async () => {
		const downloadableTrue = await getSimplifiedDOM(
			createFallbackMockBrowser({
				runtimeValue: {
					url: "http://127.0.0.1:1111/file.pdf",
					contentType: "application/pdf",
				},
			}),
		);
		assert.include(downloadableTrue, `downloadable="true"`);

		const downloadableFalse = await getSimplifiedDOM(
			createFallbackMockBrowser({
				runtimeValue: {
					url: "http://127.0.0.1:1111/file.txt",
					contentType: "text/plain",
				},
				resourceContent: "hello",
			}),
		);
		assert.include(downloadableFalse, `downloadable="false"`);

		const downloadableUnknown = await getSimplifiedDOM(
			createFallbackMockBrowser({
				runtimeValue: {
					url: "http://127.0.0.1:1111/file.unknown",
					contentType: "application/x-custom",
				},
			}),
		);
		assert.include(downloadableUnknown, `downloadable="unknown"`);
	});
});
