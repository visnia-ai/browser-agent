import { assert } from "chai";
import { describe, it } from "mocha";
import {
	close,
	getSimplifiedDOM,
	launch,
	navigate,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

describe("simplify-dom range attributes", function () {
	this.timeout(30_000);

	it("keeps min/max attributes for input[type=range]", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(
				browser,
				`data:text/html,<!doctype html><html><body><label for="r1">Volume</label><input id="r1" type="range" min="0" max="100" value="25"></body></html>`,
			);

			const simplified = await getSimplifiedDOM(browser);

			assert.match(
				simplified,
				/type="range"/,
				"simplified DOM should include range input type attribute",
			);
			assert.match(
				simplified,
				/min="0"/,
				"simplified DOM should include min attribute for range input",
			);
			assert.match(
				simplified,
				/max="100"/,
				"simplified DOM should include max attribute for range input",
			);
		} finally {
			if (browser) await close(browser);
		}
	});

	it("keeps href attributes while normalizing javascript URLs", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(
				browser,
				`data:text/html,<!doctype html><html><body><a id="a1" href="javascript:void(0)">A1</a><a id="a2" href="javascript: void(0)">A2</a><a id="a3" href="/keep">A3</a></body></html>`,
			);

			const simplified = await getSimplifiedDOM(browser, {
				omitHrefs: false,
			});

			assert.match(
				simplified,
				/href=""/i,
				"javascript hrefs should be retained as normalized empty values",
			);
			assert.include(simplified, 'href="/keep"');
			assert.include(simplified, "A1");
			assert.include(simplified, "A2");
			assert.include(simplified, "A3");
		} finally {
			if (browser) await close(browser);
		}
	});

	it("omits aria-labelledby attributes from simplified dom", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(
				browser,
				`data:text/html,<!doctype html><html><body><h2 id="heading">Heading</h2><div aria-labelledby="heading">Content</div></body></html>`,
			);

			const simplified = await getSimplifiedDOM(browser);
			assert.notMatch(
				simplified,
				/aria-labelledby=/i,
				"simplified DOM should not include aria-labelledby attributes",
			);
		} finally {
			if (browser) await close(browser);
		}
	});
});
