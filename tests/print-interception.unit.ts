import { assert } from "chai";
import { describe, it } from "mocha";
import { buildPrintPdfFileName } from "../src/browser/print-interception.js";

describe("print interception", () => {
	it("builds sanitized print PDF filenames from page titles", () => {
		assert.strictEqual(
			buildPrintPdfFileName({
				title: 'Quarterly / Report: "Final"',
				timestampMs: 123,
			}),
			"print-Quarterly - Report- -Final-123.pdf",
		);
	});

	it("falls back to the URL when the title is blank", () => {
		assert.strictEqual(
			buildPrintPdfFileName({
				title: " ",
				url: "https://example.test/invoice?id=7",
				timestampMs: 456,
			}),
			"print-https-example.test-invoice-id=7-456.pdf",
		);
	});
});
