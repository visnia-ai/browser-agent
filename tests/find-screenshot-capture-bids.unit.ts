import { assert } from "chai";
import { describe, it } from "mocha";
import {
	close,
	findScreenshotCaptureBids,
	launch,
	navigate,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

const PAGE_HTML = `<!doctype html>
<html>
  <body>
    <div data-bid="small-root" style="width: 400px; height: 400px;">
      <div data-bid="small-parent" style="width: 300px; height: 300px;">
        <button data-bid="small-child">Child</button>
      </div>
    </div>

    <div data-bid="large-root" style="width: 600px; height: 600px;">
      <div data-bid="large-parent" style="width: 450px; height: 450px;">
        <button data-bid="large-child">Large Child</button>
      </div>
    </div>

    <div data-bid="group" style="width: 320px; height: 320px;">
      <button data-bid="group-a">A</button>
      <button data-bid="group-b">B</button>
    </div>

    <div data-bid="outer" style="width: 480px; height: 480px;">
      <div data-bid="inner" style="width: 340px; height: 340px;">
        <button data-bid="inner-leaf">Leaf</button>
      </div>
    </div>

    <div data-bid="skip-root" style="width: 420px; height: 420px;">
      <div style="width: 350px; height: 350px;">
        <button data-bid="skip-child">Skip Parent With No Bid</button>
      </div>
    </div>
  </body>
</html>`;

const PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE_HTML)}`;

describe("find-screenshot-capture-bids", () => {
	it("promotes target bids to best screenshot capture ancestors", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, PAGE_URL);

			assert.deepEqual(
				await findScreenshotCaptureBids(browser, ["small-child"]),
				["small-root"],
				"Should promote to highest parent bid while parent sizes stay <= 500x500.",
			);

			assert.deepEqual(
				await findScreenshotCaptureBids(browser, ["large-child"]),
				["large-parent"],
				"Should stop climbing before parent whose dimensions exceed 500x500.",
			);

			assert.deepEqual(
				await findScreenshotCaptureBids(browser, ["group-a", "group-b"]),
				["group"],
				"Should avoid duplicate overlap when multiple bids promote to same parent.",
			);

			assert.deepEqual(
				await findScreenshotCaptureBids(browser, ["inner-leaf", "outer"]),
				["outer"],
				"Should remove overlap when one selected bid belongs to another selected bid.",
			);

			assert.deepEqual(
				await findScreenshotCaptureBids(browser, ["missing", "group-a"]),
				["missing", "group"],
				"Should preserve missing bids while still promoting existing bids.",
			);

			assert.deepEqual(
				await findScreenshotCaptureBids(browser, ["skip-child"]),
				["skip-root"],
				"Should continue climbing through parents that do not have data-bid.",
			);
		} finally {
			if (browser) {
				await close(browser);
			}
		}
	});
});
