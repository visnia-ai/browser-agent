import { assert } from "chai";
import { describe, it } from "mocha";
import sharp from "sharp";
import { captureScreenshotWithBidBorders } from "../src/browser/interaction/capture-screenshot-with-bid-borders.js";

type EvaluateCall = { expression: string; awaitPromise?: boolean };
type DomCall =
	| { method: "enable" }
	| { method: "getDocument" }
	| { method: "querySelectorAll"; selector: string }
	| { method: "describeNode"; nodeId: number }
	| { method: "resolveNode"; nodeId: number }
	| { method: "getContentQuads"; nodeId: number }
	| { method: "getBoxModel"; nodeId: number };

function buildPngBase64(width: number, height: number): string {
	const signature = Buffer.from("89504e470d0a1a0a", "hex");
	const ihdrLength = Buffer.from("0000000d", "hex");
	const ihdrType = Buffer.from("49484452", "hex");
	const ihdrData = Buffer.alloc(13, 0);
	ihdrData.writeUInt32BE(width, 0);
	ihdrData.writeUInt32BE(height, 4);
	ihdrData[8] = 8;
	ihdrData[9] = 6;
	const ihdrCrc = Buffer.alloc(4, 0);
	const iend = Buffer.from("0000000049454e44ae426082", "hex");
	return Buffer.concat([
		signature,
		ihdrLength,
		ihdrType,
		ihdrData,
		ihdrCrc,
		iend,
	]).toString("base64");
}

async function buildValidPngBase64(
	width: number,
	height: number,
): Promise<string> {
	const bytes = await sharp({
		create: {
			width,
			height,
			channels: 4,
			background: { r: 12, g: 36, b: 78, alpha: 1 },
		},
	})
		.png()
		.toBuffer();
	return bytes.toString("base64");
}

function makeRuntime(evaluateCalls?: EvaluateCall[]) {
	return {
		evaluate: async (call: EvaluateCall) => {
			evaluateCalls?.push(call);
			if (call.expression.includes("scrollX")) {
				return {
					result: {
						type: "object" as const,
						value: { scrollX: 0, scrollY: 0 },
					},
				};
			}
			if (call.expression.includes("window.devicePixelRatio")) {
				return { result: { type: "number" as const, value: 2 } };
			}
			return { result: { type: "undefined" as const } };
		},
		callFunctionOn: async () => ({
			result: {
				type: "object" as const,
				value: {
					top: [[0, 1]],
					bottom: [[0, 1]],
					left: [[0, 1]],
					right: [[0, 1]],
					visibleRatio: 1,
				},
			},
		}),
	};
}

function makeDom(domCalls?: DomCall[]) {
	return {
		enable: async () => {
			domCalls?.push({ method: "enable" });
		},
		getDocument: async () => {
			domCalls?.push({ method: "getDocument" });
			return { root: { nodeId: 1 } };
		},
		querySelectorAll: async ({
			selector,
		}: {
			nodeId: number;
			selector: string;
		}) => {
			domCalls?.push({ method: "querySelectorAll", selector });
			return { nodeIds: [] as number[] };
		},
		describeNode: async ({ nodeId }: { nodeId: number }) => {
			domCalls?.push({ method: "describeNode", nodeId });
			return { node: { attributes: [] as string[] } };
		},
		resolveNode: async ({ nodeId }: { nodeId: number }) => {
			domCalls?.push({ method: "resolveNode", nodeId });
			return { object: { objectId: `node-${nodeId}` } };
		},
		getContentQuads: async ({ nodeId }: { nodeId: number }) => {
			domCalls?.push({ method: "getContentQuads", nodeId });
			return { quads: [] as number[][] };
		},
		getBoxModel: async ({ nodeId }: { nodeId: number }) => {
			domCalls?.push({ method: "getBoxModel", nodeId });
			return { model: { border: [] as number[] } };
		},
	};
}

describe("capture-screenshot-with-bid-borders", () => {
	it("collects bid geometry via DOM domain and captures without mutating DOM by default", async () => {
		const evaluateCalls: EvaluateCall[] = [];
		const domCalls: DomCall[] = [];
		const runtime = makeRuntime(evaluateCalls);
		const dom = makeDom(domCalls);
		const captureCalls: unknown[] = [];
		const page = {
			captureScreenshot: async (params: unknown) => {
				captureCalls.push(params);
				return { data: "base64-image" };
			},
		};

		const image = await captureScreenshotWithBidBorders({
			page,
			runtime,
			dom,
			bids: ["alpha, beta", "beta", "gamma"],
			captureScreenshotParams: { format: "png" },
		});

		assert.strictEqual(image, "base64-image");
		assert.strictEqual(captureCalls.length, 1);
		assert.deepEqual(captureCalls[0], { format: "png" });
		assert.isTrue(
			evaluateCalls.some((call) => call.expression.includes("scrollX")),
		);
		assert.isTrue(
			evaluateCalls.some((call) =>
				call.expression.includes("window.devicePixelRatio"),
			),
		);
		assert.deepEqual(domCalls, [
			{ method: "enable" },
			{ method: "getDocument" },
			{ method: "querySelectorAll", selector: "[data-bid]" },
		]);
	});

	it("skips hidden and pruned elements when applying bid borders", async () => {
		const evaluateCalls: EvaluateCall[] = [];
		const dom = makeDom();
		const runtime = {
			...makeRuntime(),
			evaluate: async (call: EvaluateCall) => {
				evaluateCalls.push(call);
				return { result: { type: "undefined" as const } };
			},
		};
		const page = {
			captureScreenshot: async () => ({ data: "base64-image" }),
		};

		await captureScreenshotWithBidBorders({
			page,
			runtime,
			dom,
			bids: ["target"],
			captureScreenshotParams: { format: "png" },
			keepBordersInDom: true,
		});

		assert.strictEqual(evaluateCalls.length, 2);
		const expression = evaluateCalls[0].expression;
		assert.include(
			expression,
			`const prunedSkipAttr = "data-ba-irrelevant-pruned";`,
		);
		assert.include(
			expression,
			`if (el.getAttribute(prunedSkipAttr) === "true") return true;`,
		);
		assert.include(
			expression,
			`if (el.hasAttribute("hidden")) return true;`,
		);
		assert.include(
			expression,
			`if (style.display === "none") return true;`,
		);
		assert.include(
			expression,
			`if (style.visibility === "hidden" || style.visibility === "collapse") return true;`,
		);
		assert.include(
			expression,
			`if (Number.parseFloat(style.opacity || "1") === 0) return true;`,
		);
		assert.include(
			expression,
			`if (rect.width <= 0 || rect.height <= 0) return true;`,
		);
		assert.include(expression, `if (shouldSkipBidBorder(el)) continue;`);
		assert.include(
			expression,
			`const labelMarkerAttr = "data-ba-screenshot-bid-label";`,
		);
		assert.include(expression, `const ignoreAttr = "data-ba-ignore";`);
		assert.include(
			expression,
			`document.querySelectorAll("[" + labelMarkerAttr + '="true"]')`,
		);
		assert.include(
			expression,
			`const label = document.createElement("span");`,
		);
		assert.include(
			expression,
			`const firstBid = bidParts[0] || matchingBid;`,
		);
		assert.include(expression, `label.textContent = firstBid;`);
		assert.include(expression, `label.setAttribute(ignoreAttr, "true");`);
		assert.include(expression, `el.prepend(label);`);
		assert.include(evaluateCalls[1].expression, "window.devicePixelRatio");
	});

	it("keeps borders in the DOM when requested", async () => {
		let evaluateCount = 0;
		const dom = makeDom();
		const runtime = {
			...makeRuntime(),
			evaluate: async () => {
				evaluateCount += 1;
				return { result: { type: "undefined" as const } };
			},
		};
		const page = {
			captureScreenshot: async () => ({ data: "base64-image" }),
		};

		await captureScreenshotWithBidBorders({
			page,
			runtime,
			dom,
			bids: ["target"],
			captureScreenshotParams: { format: "jpeg", quality: 30 },
			keepBordersInDom: true,
		});

		assert.strictEqual(evaluateCount, 2);
	});

	it("still clears borders when capture fails", async () => {
		const evaluateCalls: EvaluateCall[] = [];
		const dom = makeDom();
		const runtime = {
			...makeRuntime(),
			evaluate: async (call: EvaluateCall) => {
				evaluateCalls.push(call);
				if (call.expression.includes("scrollX")) {
					return {
						result: {
							type: "object" as const,
							value: { scrollX: 0, scrollY: 0 },
						},
					};
				}
				return { result: { type: "undefined" as const } };
			},
		};
		const page = {
			captureScreenshot: async () => {
				throw new Error("capture failed");
			},
		};

		let thrownMessage = "";
		try {
			await captureScreenshotWithBidBorders({
				page,
				runtime,
				dom,
				bids: ["target"],
				captureScreenshotParams: { format: "png" },
			});
		} catch (error) {
			thrownMessage =
				error instanceof Error ? error.message : String(error);
		}

		assert.strictEqual(thrownMessage, "capture failed");
		assert.strictEqual(evaluateCalls.length, 2);
	});

	it("downsamples screenshot when window.devicePixelRatio is greater than 1", async () => {
		const evaluateCalls: EvaluateCall[] = [];
		const sourcePng = await buildValidPngBase64(120, 60);
		const dom = makeDom();
		const runtime = makeRuntime(evaluateCalls);
		const captureCalls: unknown[] = [];
		const page = {
			captureScreenshot: async (params: unknown) => {
				captureCalls.push(params);
				return { data: sourcePng };
			},
		};

		const image = await captureScreenshotWithBidBorders({
			page,
			runtime,
			dom,
			captureScreenshotParams: {
				format: "png",
			},
		});

		const outputMetadata = await sharp(
			Buffer.from(image, "base64"),
		).metadata();
		assert.deepEqual(
			{ width: outputMetadata.width, height: outputMetadata.height },
			{ width: 60, height: 30 },
		);
		assert.strictEqual(captureCalls.length, 1);
		assert.isTrue(
			evaluateCalls.some((call) =>
				call.expression.includes("window.devicePixelRatio"),
			),
		);
	});

	it("recaptures with viewport when a full-page screenshot is too tall", async () => {
		const runtime = {
			...makeRuntime(),
			evaluate: async () => ({
				result: { type: "undefined" as const },
			}),
		};
		const dom = makeDom();
		const captureCalls: unknown[] = [];
		const page = {
			captureScreenshot: async (params: unknown) => {
				captureCalls.push(params);
				if (captureCalls.length === 1) {
					return { data: buildPngBase64(1280, 5001) };
				}
				return { data: "viewport-fallback-image" };
			},
		};

		const image = await captureScreenshotWithBidBorders({
			page,
			runtime,
			dom,
			captureScreenshotParams: {
				format: "png",
				captureBeyondViewport: true,
			},
		});

		assert.strictEqual(image, "viewport-fallback-image");
		assert.strictEqual(captureCalls.length, 2);
		assert.deepEqual(captureCalls[0], {
			format: "png",
			captureBeyondViewport: true,
		});
		assert.deepEqual(captureCalls[1], {
			format: "png",
			captureBeyondViewport: false,
		});
	});

	it("recaptures with viewport when a full-page screenshot is empty", async () => {
		const runtime = {
			...makeRuntime(),
			evaluate: async () => ({
				result: { type: "undefined" as const },
			}),
		};
		const captureCalls: unknown[] = [];
		const page = {
			captureScreenshot: async (params: unknown) => {
				captureCalls.push(params);
				return {
					data:
						captureCalls.length === 1
							? ""
							: "viewport-fallback-image",
				};
			},
		};

		const image = await captureScreenshotWithBidBorders({
			page,
			runtime,
			dom: makeDom(),
			captureScreenshotParams: {
				format: "png",
				captureBeyondViewport: true,
			},
		});

		assert.strictEqual(image, "viewport-fallback-image");
		assert.deepEqual(captureCalls, [
			{ format: "png", captureBeyondViewport: true },
			{ format: "png", captureBeyondViewport: false },
		]);
	});

	it("does not use viewport fallback for clipped or viewport-only captures", async () => {
		const runtime = {
			...makeRuntime(),
			evaluate: async () => ({
				result: { type: "undefined" as const },
			}),
		};
		const cases = [
			{
				format: "png" as const,
				captureBeyondViewport: true,
				clip: { x: 0, y: 0, width: 1280, height: 5001, scale: 1 },
			},
			{
				format: "png" as const,
				captureBeyondViewport: false,
			},
		];

		for (const captureScreenshotParams of cases) {
			const captureCalls: unknown[] = [];
			const page = {
				captureScreenshot: async (params: unknown) => {
					captureCalls.push(params);
					return { data: buildPngBase64(1280, 5001) };
				},
			};

			const image = await captureScreenshotWithBidBorders({
				page,
				runtime,
				dom: makeDom(),
				captureScreenshotParams,
			});

			assert.notStrictEqual(image, "");
			assert.deepEqual(captureCalls, [captureScreenshotParams]);
		}
	});
});
