import { assert } from "chai";
import { describe, it } from "mocha";
import {
	close,
	getSemanticProjection,
	launch,
	longPress,
	navigate,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

function buildLongPressPageDataUrl(removeOnDown = false): string {
	const html = `<!doctype html>
<html>
  <body>
    <button data-bid="hold" id="hold">Press and hold</button>
    <script>
      window.events = [];
      const button = document.getElementById("hold");
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        document.addEventListener(type, (event) => {
          window.events.push({
            type,
            trusted: event.isTrusted,
            at: performance.now(),
          });
        }, true);
      }
      ${
			removeOnDown
				? `button.addEventListener("pointerdown", () => button.remove());`
				: ""
		}
    </script>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

async function readEvents(
	browser: Browser,
): Promise<Array<{ type: string; trusted: boolean; at: number }>> {
	const { result } = await browser.Runtime.evaluate({
		expression: "window.events",
		returnByValue: true,
	});
	return result.value as Array<{
		type: string;
		trusted: boolean;
		at: number;
	}>;
}

async function getHoldButtonRef(browser: Browser): Promise<string> {
	const projection = await getSemanticProjection(browser);
	const targetLine = projection
		.split("\n")
		.find((line) => line.includes('name="Press and hold"'));
	const ref = /\bref="([^"]+)"/.exec(targetLine ?? "")?.[1];
	assert.isString(ref, `expected hold button ref in ${projection}`);
	return ref ?? "";
}

describe("long press interaction e2e", function () {
	this.timeout(90_000);

	it("holds a target using trusted CDP pointer events for the requested duration", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildLongPressPageDataUrl());

			await longPress(browser, await getHoldButtonRef(browser), 200);

			const events = await readEvents(browser);
			assert.deepEqual(
				events.map((event) => event.type),
				["pointerdown", "mousedown", "pointerup", "mouseup"],
			);
			assert.isTrue(events.every((event) => event.trusted));
			assert.isAtLeast(events[2].at - events[0].at, 180);
		} finally {
			if (browser) await close(browser);
		}
	});

	it("always releases the pointer when the target disappears during the hold", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildLongPressPageDataUrl(true));

			await longPress(browser, await getHoldButtonRef(browser), 100);

			const events = await readEvents(browser);
			assert.includeMembers(
				events.map((event) => event.type),
				["pointerdown", "mousedown", "pointerup", "mouseup"],
			);
			assert.isTrue(events.every((event) => event.trusted));
		} finally {
			if (browser) await close(browser);
		}
	});
});
