import { assert } from "chai";
import { describe, it } from "mocha";
import { capturePreviewDataUrl } from "../src/browser/browser.js";
import { getPageFaviconForPreview } from "../src/browser/favicon-preview.js";

describe("browser preview capture", () => {
	it("captures the full CSS viewport without DPR downscaling", async () => {
		let receivedClip:
			| {
					x: number;
					y: number;
					width: number;
					height: number;
					scale: number;
			  }
			| undefined;

		const dataUrl = await capturePreviewDataUrl({
			Page: {
				getLayoutMetrics: async () =>
					({
						cssVisualViewport: {
							pageX: 10.4,
							pageY: 20.9,
							clientWidth: 1440.8,
							clientHeight: 900.2,
						},
					}) as never,
				captureScreenshot: async (params) => {
					receivedClip = params.clip as typeof receivedClip;
					assert.strictEqual(params.format, "webp");
					assert.strictEqual(params.quality, 30);
					return { data: "AAAA" } as never;
				},
			},
			Runtime: {
				evaluate: async () => ({ result: { value: 1 } }) as never,
			},
		} as never);

		assert.strictEqual(dataUrl, "data:image/webp;base64,AAAA");
		assert.deepEqual(receivedClip, {
			x: 10.4,
			y: 20.9,
			width: 1440,
			height: 900,
			scale: 1,
		});
	});

	it("throws when Chrome returns empty preview bytes", async () => {
		try {
			await capturePreviewDataUrl({
				Page: {
					getLayoutMetrics: async () =>
						({
							cssVisualViewport: {
								pageX: 0,
								pageY: 0,
								clientWidth: 1280,
								clientHeight: 720,
							},
						}) as never,
					captureScreenshot: async () => ({ data: "" }) as never,
				},
				Runtime: {
					evaluate: async () => ({ result: { value: 1 } }) as never,
				},
			} as never);
			assert.fail("Expected capturePreviewDataUrl to throw");
		} catch (error) {
			assert.instanceOf(error, Error);
			assert.include(
				String((error as Error).message),
				"empty image data",
			);
		}
	});
});

describe("getPageFaviconForPreview", () => {
	it("returns favicon fields from Runtime.evaluate result", async () => {
		const out = await getPageFaviconForPreview({
			Runtime: {
				evaluate: async () =>
					({
						result: {
							value: {
								faviconHttpUrl: "https://x.test/f.ico",
								faviconDataUrl: "data:image/png;base64,QUJD",
							},
						},
					}) as never,
			},
		} as never);
		assert.strictEqual(out.faviconHttpUrl, "https://x.test/f.ico");
		assert.strictEqual(out.faviconDataUrl, "data:image/png;base64,QUJD");
	});

	it("returns empty object on evaluate exception details", async () => {
		const out = await getPageFaviconForPreview({
			Runtime: {
				evaluate: async () =>
					({
						exceptionDetails: { text: "fail" },
					}) as never,
			},
		} as never);
		assert.deepStrictEqual(out, {});
	});
});
