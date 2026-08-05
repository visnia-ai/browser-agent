import assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { Browser } from "../src/browser/types.js";
import {
	navigate,
	isSupportedInBrowserNavigateUrl,
	shouldAwaitPageLoadAfterNavigate,
} from "../src/browser/browser.js";

describe("shouldAwaitPageLoadAfterNavigate", () => {
	it("skips waiting for external protocol navigations", () => {
		assert.equal(
			shouldAwaitPageLoadAfterNavigate({
				url: "mailto:test@example.com?subject=Hello",
			}),
			false,
		);
	});

	it("waits for normal document navigations", () => {
		assert.equal(
			shouldAwaitPageLoadAfterNavigate({
				url: "https://www.bestbuy.com",
			}),
			true,
		);
	});

	it("reports external protocol navigations as unsupported browser targets", () => {
		assert.equal(
			isSupportedInBrowserNavigateUrl(
				"mailto:test@example.com?subject=Hello",
			),
			false,
		);
		assert.equal(isSupportedInBrowserNavigateUrl("tel:+123456789"), false);
		assert.equal(
			isSupportedInBrowserNavigateUrl("https://www.bestbuy.com"),
			true,
		);
	});
});

describe("navigate", () => {
	it("does not wait for a page load event on mailto urls", async () => {
		let loadEventWaited = false;
		const browser = {
			Page: {
				navigate: async () => ({ frameId: "frame-1" }),
				loadEventFired: async () => {
					loadEventWaited = true;
				},
			},
		} as unknown as Browser;

		await navigate(browser, "mailto:test@example.com?subject=Hello");

		assert.equal(loadEventWaited, false);
	});
});
