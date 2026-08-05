import { assert } from "chai";
import { encoding_for_model } from "tiktoken";
import { describe, it } from "mocha";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import {
	minifySimplifiedDOM,
	unminifySimplifiedDOM,
} from "../src/browser/simplified-dom-minifier.js";
import { getRawMainDocumentHTML } from "../src/browser/browser.js";
import {
	getSimplifiedDOM,
	launch,
	navigate,
	close,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_FLIGHTS_URL = pathToFileURL(
	path.resolve(TEST_DIR, "../assets/raw-html-022.html"),
).href;

function tokenCount(
	encoding: ReturnType<typeof encoding_for_model>,
	text: string,
): number {
	return encoding.encode(text).length;
}

describe("simplified-dom-minifier e2e", function () {
	this.timeout(90_000);

	it("round-trips simplified DOM and keeps token counts non-zero", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, GOOGLE_FLIGHTS_URL);

			// Ensure runtime works.
			const html = await getRawMainDocumentHTML(browser);
			assert(
				html.length > 0,
				"Runtime check failed: fetched HTML is empty.",
			);

			const simplifiedDOM = await getSimplifiedDOM(browser);
			const minified = minifySimplifiedDOM(simplifiedDOM);
			const roundTripped = unminifySimplifiedDOM(minified);
			assert.strictEqual(
				roundTripped,
				simplifiedDOM,
				"Round-trip mismatch: unminified text differs from original input.",
			);

			const encoding = encoding_for_model("gpt-4o-mini");
			try {
				const sourceTokens = tokenCount(encoding, simplifiedDOM);
				const minifiedTokens = tokenCount(encoding, minified);

				assert(
					sourceTokens > 0,
					`Expected source token count to be > 0 (got ${sourceTokens}).`,
				);
				assert(
					minifiedTokens > 0,
					`Expected minified token count to be > 0 (got ${minifiedTokens}).`,
				);
			} finally {
				encoding.free();
			}
		} finally {
			if (browser) {
				await close(browser);
			}
		}
	});
});
