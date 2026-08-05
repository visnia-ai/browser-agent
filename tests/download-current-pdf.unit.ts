import { assert } from "chai";
import { describe, it } from "mocha";
import {
	extractFileUrlFromViewerUrl,
	extractPdfUrlFromViewerUrl,
} from "../src/browser/download-current-pdf.js";

describe("download current pdf helpers", () => {
	it("extracts the source PDF from Chrome viewer query params", () => {
		const viewerUrl =
			"chrome-extension://viewer/index.html?src=https%3A%2F%2Fexample.com%2Ffiles%2Freport.pdf";

		assert.strictEqual(
			extractPdfUrlFromViewerUrl(viewerUrl),
			"https://example.com/files/report.pdf",
		);
	});

	it("extracts blob pdf URLs from hash params", () => {
		const viewerUrl =
			"chrome-extension://viewer/index.html#src=blob%3Ahttps%3A%2F%2Fexample.com%2F1234";

		assert.strictEqual(
			extractPdfUrlFromViewerUrl(viewerUrl),
			"blob:https://example.com/1234",
		);
	});

	it("extracts non-pdf file URLs from viewer params", () => {
		const viewerUrl =
			"chrome-extension://viewer/index.html?url=https%3A%2F%2Fexample.com%2Ffiles%2Fdata.csv";
		assert.strictEqual(
			extractFileUrlFromViewerUrl(viewerUrl),
			"https://example.com/files/data.csv",
		);
	});

	it("returns null when the URL does not describe a pdf document", () => {
		assert.isNull(
			extractPdfUrlFromViewerUrl(
				"https://example.com/viewer?src=https://example.com/file.txt",
			),
		);
	});
});
