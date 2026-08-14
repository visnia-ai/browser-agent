import { assert } from "chai";
import { describe, it } from "mocha";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "../src/browser/types.js";
import {
	downloadFileFromUrl,
	extractFileUrlFromViewerUrl,
	extractPdfUrlFromViewerUrl,
	getPdfUrlForTab,
	isPdfViewerTab,
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

	it("classifies direct PDF tabs", () => {
		const tab = {
			url: "https://example.com/files/report.pdf?download=0#page=2",
			title: "Report",
		};

		assert.strictEqual(
			getPdfUrlForTab(tab),
			"https://example.com/files/report.pdf?download=0#page=2",
		);
		assert.isTrue(isPdfViewerTab(tab));
	});

	it("classifies PDF tabs opened through viewer URL parameters", () => {
		const tab = {
			url: "chrome-extension://viewer/index.html?file=https%3A%2F%2Fexample.com%2Freport.pdf",
			title: "report.pdf",
		};

		assert.strictEqual(
			getPdfUrlForTab(tab),
			"https://example.com/report.pdf",
		);
		assert.isTrue(isPdfViewerTab(tab));
	});

	it("classifies blob PDF viewer tabs", () => {
		const tab = {
			url: "chrome-extension://viewer/index.html#src=blob%3Ahttps%3A%2F%2Fexample.com%2F1234",
			title: "report.pdf",
		};

		assert.strictEqual(
			getPdfUrlForTab(tab),
			"blob:https://example.com/1234",
		);
		assert.isTrue(isPdfViewerTab(tab));
	});

	it("classifies application/pdf data tabs", () => {
		const tab = {
			url: "data:application/pdf;base64,JVBERi0xLjQ=",
			title: "Document",
		};

		assert.strictEqual(getPdfUrlForTab(tab), tab.url);
		assert.isTrue(isPdfViewerTab(tab));
	});

	it("uses a PDF filename title for opaque viewer URLs", () => {
		const tab = {
			url: "https://example.com/download?id=42",
			title: "quarterly-report.pdf",
		};

		assert.strictEqual(getPdfUrlForTab(tab), tab.url);
		assert.isTrue(isPdfViewerTab(tab));
	});

	it("does not classify ordinary HTML or non-PDF viewer tabs", () => {
		const tabs = [
			{
				url: "https://example.com/guides/pdf-documentation",
				title: "PDF documentation",
			},
			{
				url: "chrome-extension://viewer/index.html?file=https%3A%2F%2Fexample.com%2Fdata.csv",
				title: "data.csv",
			},
			{
				url: "data:text/plain,not-a-pdf",
				title: "Text document",
			},
		];

		for (const tab of tabs) {
			assert.isNull(getPdfUrlForTab(tab));
			assert.isFalse(isPdfViewerTab(tab));
		}
	});

	it("downloads a PDF URL through the active source tab's browser context", async () => {
		const downloadDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-agent-pdf-url-"),
		);
		const originalFetch = globalThis.fetch;
		let requestHeaders: Headers | undefined;
		globalThis.fetch = (async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response("%PDF-1.7\nfixture", {
				status: 200,
				headers: {
					"content-type": "application/pdf",
					"content-disposition": 'attachment; filename="report.pdf"',
				},
			});
		}) as typeof fetch;
		const browser = {
			downloadDir,
			client: {
				send: async () => ({
					cookies: [{ name: "session", value: "secret" }],
				}),
			},
			Runtime: {
				evaluate: async () => ({
					result: { value: "BrowserAgent/1.0" },
				}),
			},
		} as unknown as Browser;

		try {
			const destination = await downloadFileFromUrl(
				browser,
				"https://example.com/report.pdf",
			);
			assert.strictEqual(path.basename(destination), "report.pdf");
			assert.strictEqual(
				fs.readFileSync(destination, "utf8"),
				"%PDF-1.7\nfixture",
			);
			assert.strictEqual(
				requestHeaders?.get("cookie"),
				"session=secret",
			);
			assert.strictEqual(
				requestHeaders?.get("user-agent"),
				"BrowserAgent/1.0",
			);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(downloadDir, { recursive: true, force: true });
		}
	});
});
