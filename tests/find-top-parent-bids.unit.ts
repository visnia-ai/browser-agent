import { assert } from "chai";
import { describe, it } from "mocha";
import {
	close,
	findTopParentBids,
	launch,
	navigate,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

const PAGE_HTML = `<!doctype html>
<html>
  <body>
    <div data-bid="parent">
      <button data-bid="child">Child</button>
    </div>
    <div data-bid="sibling">Sibling</div>
    <section data-bid="outer">
      <div data-bid="middle">
        <span data-bid="inner">Inner</span>
      </div>
    </section>
  </body>
</html>`;

const PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE_HTML)}`;

describe("find-top-parent-bids", () => {
	it("filters bids to top-level parent selections", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, PAGE_URL);

			assert.deepEqual(
				await findTopParentBids(browser, ["child", "parent"]),
				["parent"],
			);

			assert.deepEqual(
				await findTopParentBids(browser, ["sibling", "parent"]),
				["sibling", "parent"],
			);

			assert.deepEqual(
				await findTopParentBids(browser, ["inner", "middle", "outer"]),
				["outer"],
			);

			assert.deepEqual(
				await findTopParentBids(browser, ["missing", "child", "parent"]),
				["missing", "parent"],
			);

			assert.deepEqual(await findTopParentBids(browser, ["a, b"]), [
				"a",
				"b",
			]);
		} finally {
			if (browser) {
				await close(browser);
			}
		}
	});
});
