import { assert } from "chai";
import { describe, it } from "mocha";
import { Buffer } from "node:buffer";
import {
	capturePreviewDataUrl,
	close,
	launch,
	navigate,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

/**
 * Same viewport clip logic as {@link capturePreviewDataUrl} so JPEG vs WebP are comparable.
 */
async function captureViewportClip(browser: Browser) {
	const metrics = await browser.Page.getLayoutMetrics();
	const viewport = metrics.cssVisualViewport;
	return {
		x: viewport.pageX,
		y: viewport.pageY,
		width: Math.max(1, Math.floor(viewport.clientWidth)),
		height: Math.max(1, Math.floor(viewport.clientHeight)),
		scale: 1,
	};
}

async function capturePreviewFormatBytes(
	browser: Browser,
	input:
		| { format: "jpeg"; quality: number }
		| { format: "webp"; quality?: number },
): Promise<number> {
	const clip = await captureViewportClip(browser);
	const base = {
		captureBeyondViewport: false,
		fromSurface: true,
		clip,
	} as const;
	const captured =
		input.format === "jpeg"
			? await browser.Page.captureScreenshot({
					...base,
					format: "jpeg",
					quality: input.quality,
				})
			: await browser.Page.captureScreenshot({
					...base,
					format: "webp",
					...(typeof input.quality === "number"
						? { quality: input.quality }
						: {}),
				});

	if (!captured.data) {
		throw new Error(
			`${input.format} preview capture returned empty image data.`,
		);
	}
	return Buffer.from(captured.data, "base64").length;
}

/** Rich static UI (text, flat fills, gradient) similar to dashboard-style pages. */
function fixtureDataUrl(): string {
	const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"/><title>preview format fixture</title></head>
  <body style="margin:0;font:14px system-ui,Segoe UI,sans-serif;color:#1a1a1a">
    <header style="padding:12px 16px;background:linear-gradient(90deg,#2563eb,#7c3aed);color:#fff">
      Preview format comparison fixture
    </header>
    <main style="padding:16px;max-width:960px">
      <h1 style="font-size:20px;margin:0 0 8px">Section title</h1>
      <p style="line-height:1.5;margin:0 0 12px">
        Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer nec odio.
        Praesent libero. Sed cursus ante dapibus diam.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span style="background:#f3f4f6;border-radius:6px;padding:6px 10px">Tag A</span>
        <span style="background:#ecfdf5;border-radius:6px;padding:6px 10px;color:#047857">Tag B</span>
        <span style="background:#fef3c7;border-radius:6px;padding:6px 10px;color:#b45309">Tag C</span>
      </div>
      <table style="margin-top:16px;border-collapse:collapse;width:100%;font-size:13px">
        <tr style="background:#f9fafb"><th style="text-align:left;padding:8px;border:1px solid #e5e7eb">Item</th>
        <th style="text-align:right;padding:8px;border:1px solid #e5e7eb">Qty</th></tr>
        <tr><td style="padding:8px;border:1px solid #e5e7eb">Alpha</td><td style="text-align:right;padding:8px;border:1px solid #e5e7eb">42</td></tr>
        <tr><td style="padding:8px;border:1px solid #e5e7eb">Beta</td><td style="text-align:right;padding:8px;border:1px solid #e5e7eb">7</td></tr>
      </table>
    </main>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

describe("preview screenshot format size (e2e)", function () {
	this.timeout(90_000);

	it("webp viewport capture is smaller than jpeg q=20 on a representative UI fixture", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, fixtureDataUrl());

			const jpegBytes = await capturePreviewFormatBytes(browser, {
				format: "jpeg",
				quality: 20,
			});
			const webpBytes = await capturePreviewFormatBytes(browser, {
				format: "webp",
			});

			assert.isAtLeast(
				jpegBytes,
				500,
				"jpeg payload unexpectedly tiny; capture may be broken",
			);
			assert.isAtLeast(
				webpBytes,
				200,
				"webp payload unexpectedly tiny; capture may be broken",
			);

			const savings = 1 - webpBytes / jpegBytes;
			assert.isBelow(
				webpBytes,
				jpegBytes,
				`expected webp smaller than jpeg (jpeg=${jpegBytes} B, webp=${webpBytes} B); Chrome/CDP may have changed encoding`,
			);
			assert.isAtLeast(
				savings,
				0.05,
				`expected meaningful savings (>=5%); got ${(savings * 100).toFixed(1)}% (jpeg=${jpegBytes} webp=${webpBytes})`,
			);
		} finally {
			if (browser) await close(browser);
		}
	});

	it("matches raw CDP webp q=30 when devicePixelRatio is 1 (no downsample)", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, fixtureDataUrl());
			const dprResult = await browser.Runtime.evaluate({
				expression: "window.devicePixelRatio",
				returnByValue: true,
			});
			const dpr = Number(dprResult.result.value);
			const dataUrl = await capturePreviewDataUrl(browser);
			const fromHelper = Buffer.from(
				dataUrl.replace(/^data:image\/webp;base64,/, ""),
				"base64",
			).length;
			const direct = await capturePreviewFormatBytes(browser, {
				format: "webp",
				quality: 30,
			});
			if (!Number.isFinite(dpr) || dpr <= 1) {
				assert.strictEqual(
					fromHelper,
					direct,
					"capturePreviewDataUrl should match raw CDP webp when DPR<=1",
				);
			} else {
				assert.isAtMost(
					fromHelper,
					direct,
					"downsampled preview should not be larger than raw CDP capture",
				);
			}
		} finally {
			if (browser) await close(browser);
		}
	});
});
