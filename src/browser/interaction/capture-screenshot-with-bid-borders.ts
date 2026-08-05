import type { Browser } from "../types.js";
import { splitRefCandidates } from "./utils.js";
import { shouldLogTimingDuration } from "../../timing-logs.js";
import sharp from "sharp";
import { performance } from "node:perf_hooks";

const BORDER_MARKER_ATTR = "data-ba-screenshot-border";
const PREVIOUS_STYLE_ATTR = "data-ba-screenshot-prev-style";
const LABEL_MARKER_ATTR = "data-ba-screenshot-bid-label";
const PRUNED_SKIP_ATTR = "data-ba-irrelevant-pruned";
const IGNORE_ATTR = "data-ba-ignore";
const BORDER_PALETTE = [
	"#e11d48",
	"#f97316",
	"#f59e0b",
	"#22c55e",
	"#14b8a6",
	"#0ea5e9",
	"#3b82f6",
	"#6366f1",
	"#ec4899",
];
const MAX_SCREENSHOT_HEIGHT_PX = 4000;

type RuntimeDomain = Pick<Browser["Runtime"], "evaluate" | "callFunctionOn">;
type PageDomain = Pick<Browser["Page"], "captureScreenshot">;
type DOMDomain = Pick<
	Browser["DOM"],
	| "enable"
	| "getDocument"
	| "querySelectorAll"
	| "describeNode"
	| "resolveNode"
	| "getContentQuads"
	| "getBoxModel"
>;
export type CaptureScreenshotParams = Parameters<
	Browser["Page"]["captureScreenshot"]
>[0] extends infer T
	? T extends undefined
		? never
		: T
	: never;

interface CaptureScreenshotWithBidBordersParams {
	page: PageDomain;
	runtime: RuntimeDomain;
	dom: DOMDomain;
	captureScreenshotParams: CaptureScreenshotParams;
	bids?: string[];
	keepBordersInDom?: boolean;
}

interface BidOverlayBox {
	bid: string;
	color: string;
	viewportLeft: number;
	viewportTop: number;
	docLeft: number;
	docTop: number;
	width: number;
	height: number;
	visibleRatio: number;
	visibleEdges: EdgeVisibilityIntervals;
}

type EdgeVisibilityIntervals = {
	top: Array<[number, number]>;
	bottom: Array<[number, number]>;
	left: Array<[number, number]>;
	right: Array<[number, number]>;
};

interface ElementScrollOffset {
	scrollX: number;
	scrollY: number;
}

interface ActiveElementSnapshot {
	tag: string;
	id: string;
	className: string;
	bid: string;
}

interface RawEdgeVisibilityResult {
	top?: unknown;
	bottom?: unknown;
	left?: unknown;
	right?: unknown;
	visibleRatio?: unknown;
}

function normalizeScreenshotFormat(
	format: CaptureScreenshotParams["format"],
): "png" | "jpeg" | "webp" {
	if (format === "jpeg") return "jpeg";
	if (format === "webp") return "webp";
	return "png";
}

export async function getWindowDevicePixelRatio(
	runtime: RuntimeDomain,
): Promise<number> {
	try {
		const response = (await runtime.evaluate({
			expression: "window.devicePixelRatio",
			returnByValue: true,
		})) as { result?: { value?: unknown } };
		const rawValue = response?.result?.value;
		const dpr =
			typeof rawValue === "number"
				? rawValue
				: typeof rawValue === "string"
					? Number(rawValue)
					: Number.NaN;
		if (Number.isFinite(dpr) && dpr > 1) {
			return dpr;
		}
	} catch {
		// Ignore and fall back to no downsampling.
	}
	return 1;
}

export async function downsampleScreenshotByFactor(params: {
	base64Image: string;
	format: CaptureScreenshotParams["format"];
	quality: CaptureScreenshotParams["quality"];
	devicePixelRatio: number;
}): Promise<string> {
	if (!params.base64Image || !Number.isFinite(params.devicePixelRatio)) {
		return params.base64Image;
	}
	if (params.devicePixelRatio <= 1) {
		return params.base64Image;
	}

	const normalizedFormat = normalizeScreenshotFormat(params.format);

	try {
		const inputBuffer = Buffer.from(params.base64Image, "base64");
		if (inputBuffer.length === 0) {
			return params.base64Image;
		}

		const image = sharp(inputBuffer, { failOn: "none" });
		const metadata = await image.metadata();
		const sourceWidth = metadata.width;
		const sourceHeight = metadata.height;
		if (
			typeof sourceWidth !== "number" ||
			typeof sourceHeight !== "number" ||
			sourceWidth <= 0 ||
			sourceHeight <= 0
		) {
			return params.base64Image;
		}

		const targetWidth = Math.max(
			1,
			Math.round(sourceWidth / params.devicePixelRatio),
		);
		const targetHeight = Math.max(
			1,
			Math.round(sourceHeight / params.devicePixelRatio),
		);

		let pipeline = image.resize(targetWidth, targetHeight, {
			kernel: sharp.kernel.lanczos3,
			fit: "fill",
		});

		const encodedQuality =
			typeof params.quality === "number" &&
			Number.isFinite(params.quality)
				? Math.max(1, Math.min(100, Math.round(params.quality)))
				: 80;
		if (normalizedFormat === "jpeg") {
			pipeline = pipeline.jpeg({ quality: encodedQuality });
		} else if (normalizedFormat === "webp") {
			pipeline = pipeline.webp({ quality: encodedQuality });
		} else {
			pipeline = pipeline.png();
		}

		const outputBuffer = await pipeline.toBuffer();
		if (outputBuffer.length > 0) {
			return outputBuffer.toString("base64");
		}
	} catch {
		// If native downsampling fails, keep original screenshot.
	}

	return params.base64Image;
}

function parsePngDimensions(
	bytes: Buffer,
): { width: number; height: number } | null {
	const pngSignatureHex = "89504e470d0a1a0a";
	if (bytes.length < 24) return null;
	if (bytes.subarray(0, 8).toString("hex") !== pngSignatureHex) return null;
	const chunkType = bytes.subarray(12, 16).toString("ascii");
	if (chunkType !== "IHDR") return null;
	return {
		width: bytes.readUInt32BE(16),
		height: bytes.readUInt32BE(20),
	};
}

function parseJpegDimensions(
	bytes: Buffer,
): { width: number; height: number } | null {
	if (bytes.length < 4) return null;
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

	let offset = 2;
	while (offset + 3 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		let markerOffset = offset + 1;
		while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
			markerOffset += 1;
		}
		if (markerOffset >= bytes.length) return null;
		const marker = bytes[markerOffset];
		offset = markerOffset + 1;

		if (marker === 0xd8 || marker === 0xd9) {
			continue;
		}
		if (marker >= 0xd0 && marker <= 0xd7) {
			continue;
		}

		if (offset + 1 >= bytes.length) return null;
		const segmentLength = bytes.readUInt16BE(offset);
		if (segmentLength < 2) return null;
		const segmentStart = offset + 2;
		const segmentEnd = offset + segmentLength;
		if (segmentEnd > bytes.length) return null;

		const isStartOfFrame =
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf);
		if (isStartOfFrame) {
			if (segmentStart + 4 >= segmentEnd) return null;
			return {
				height: bytes.readUInt16BE(segmentStart + 1),
				width: bytes.readUInt16BE(segmentStart + 3),
			};
		}

		offset = segmentEnd;
	}

	return null;
}

function parseScreenshotDimensions(
	base64Image: string,
	format: CaptureScreenshotParams["format"],
): { width: number; height: number } | null {
	try {
		const bytes = Buffer.from(base64Image, "base64");
		if (bytes.length === 0) return null;
		const normalizedFormat = format || "png";
		if (normalizedFormat === "png") {
			return parsePngDimensions(bytes);
		}
		if (normalizedFormat === "jpeg") {
			return parseJpegDimensions(bytes);
		}
		// Fallback to magic-byte detection when format is omitted or unexpected.
		return parsePngDimensions(bytes) || parseJpegDimensions(bytes);
	} catch {
		return null;
	}
}

function normalizeBids(rawBids: string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const rawBid of rawBids) {
		for (const bid of splitRefCandidates(rawBid)) {
			if (!bid || seen.has(bid)) continue;
			seen.add(bid);
			normalized.push(bid);
		}
	}
	return normalized;
}

function hasScreenshotBytes(imageBase64: string): boolean {
	return imageBase64.trim().length > 0;
}

function shouldLogCaptureDebug(): boolean {
	return process.env.BA_SCREENSHOT_DEBUG_ACTIVE_ELEMENT === "1";
}

function formatBytesMegabytes(bytes: number | undefined): string {
	if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
		return "n/a";
	}
	return (bytes / (1024 * 1024)).toFixed(1);
}

function formatEluDelta(
	start: ReturnType<(typeof performance)["eventLoopUtilization"]> | undefined,
	end: ReturnType<(typeof performance)["eventLoopUtilization"]> | undefined,
): string {
	if (!start || !end) return "n/a";
	try {
		const delta = performance.eventLoopUtilization(start, end);
		return delta.utilization.toFixed(3);
	} catch {
		return "n/a";
	}
}

function logCapturePipelinePhase(params: {
	phase: string;
	durationMs: number;
	heapUsedBeforeMb: string;
	heapUsedAfterMb: string;
	rssBeforeMb: string;
	rssAfterMb: string;
	externalBeforeMb: string;
	externalAfterMb: string;
	arrayBuffersBeforeMb: string;
	arrayBuffersAfterMb: string;
	eluDelta: string;
	extra?: string;
}): void {
	if (!shouldLogTimingDuration(params.durationMs)) {
		return;
	}
	const extraSuffix = params.extra ? ` | ${params.extra}` : "";
	console.log(
		`[screenshot-pipeline] phase=${params.phase} duration_ms=${Math.round(params.durationMs)} ` +
			`heap_used_mb=${params.heapUsedBeforeMb}->${params.heapUsedAfterMb} ` +
			`rss_mb=${params.rssBeforeMb}->${params.rssAfterMb} ` +
			`external_mb=${params.externalBeforeMb}->${params.externalAfterMb} ` +
			`array_buffers_mb=${params.arrayBuffersBeforeMb}->${params.arrayBuffersAfterMb} ` +
			`elu_delta=${params.eluDelta}${extraSuffix}`,
	);
}

async function timeCapturePipelinePhase<T>(
	phase: string,
	run: () => Promise<T>,
	describe?: (result: T) => string | undefined,
): Promise<T> {
	const startedAt = performance.now();
	const eluStart =
		typeof performance.eventLoopUtilization === "function"
			? performance.eventLoopUtilization()
			: undefined;
	const memoryBefore = process.memoryUsage();
	const result = await run();
	const memoryAfter = process.memoryUsage();
	const eluEnd =
		typeof performance.eventLoopUtilization === "function"
			? performance.eventLoopUtilization()
			: undefined;

	return result;
}

function formatActiveElementSnapshot(
	snapshot: ActiveElementSnapshot | null,
): string {
	if (!snapshot) return "none";
	const idPart = snapshot.id ? `#${snapshot.id}` : "";
	const classPart = snapshot.className
		? `.${snapshot.className.trim().replace(/\s+/g, ".")}`
		: "";
	const bidPart = snapshot.bid ? ` bid=${snapshot.bid}` : "";
	return `${snapshot.tag}${idPart}${classPart}${bidPart}`;
}

async function getActiveElementSnapshot(
	runtime: RuntimeDomain,
): Promise<ActiveElementSnapshot | null> {
	try {
		const response = (await runtime.evaluate({
			expression: `(() => {
        const el = document.activeElement;
        if (!el) return null;
        const element = el;
        return {
          tag: String(element.tagName || "").toLowerCase(),
          id: String(element.id || ""),
          className: String(element.className || ""),
          bid: String(element.getAttribute?.("data-bid") || "")
        };
      })()`,
			returnByValue: true,
		})) as { result?: { value?: unknown } };
		const value = response?.result?.value;
		if (!value || typeof value !== "object") return null;
		const parsed = value as Record<string, unknown>;
		if (
			typeof parsed.tag !== "string" ||
			typeof parsed.id !== "string" ||
			typeof parsed.className !== "string" ||
			typeof parsed.bid !== "string"
		) {
			return null;
		}
		return {
			tag: parsed.tag,
			id: parsed.id,
			className: parsed.className,
			bid: parsed.bid,
		};
	} catch {
		return null;
	}
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

async function collectBidOverlayBoxes(
	dom: DOMDomain,
	runtime: RuntimeDomain,
	bids: string[],
): Promise<BidOverlayBox[]> {
	if (bids.length === 0) {
		return [];
	}
	const requestedBidSet = new Set(bids);

	const pickColor = (bid: string): string => {
		let hash = 0;
		for (let i = 0; i < bid.length; i += 1) {
			hash = (hash * 31 + bid.charCodeAt(i)) | 0;
		}
		return BORDER_PALETTE[Math.abs(hash) % BORDER_PALETTE.length];
	};
	const splitBids = (raw: string): string[] =>
		String(raw || "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);

	const scroll = (await runtime.evaluate({
		expression: "({ scrollX: window.scrollX, scrollY: window.scrollY })",
		returnByValue: true,
	})) as { result?: { value?: unknown } };
	const scrollValue = scroll?.result?.value as
		| Partial<ElementScrollOffset>
		| undefined;
	const scrollX =
		typeof scrollValue?.scrollX === "number" ? scrollValue.scrollX : 0;
	const scrollY =
		typeof scrollValue?.scrollY === "number" ? scrollValue.scrollY : 0;

	try {
		await dom.enable();
	} catch {
		// Some environments work without explicit enable.
	}
	const { root } = await dom.getDocument({ depth: -1, pierce: true });
	const { nodeIds } = await dom.querySelectorAll({
		nodeId: root.nodeId,
		selector: "[data-bid]",
	});

	const out: BidOverlayBox[] = [];
	const fullVisibleEdges: EdgeVisibilityIntervals = {
		top: [[0, 1]],
		bottom: [[0, 1]],
		left: [[0, 1]],
		right: [[0, 1]],
	};

	const toIntervals = (raw: unknown): Array<[number, number]> => {
		if (!Array.isArray(raw)) return [];
		const intervals: Array<[number, number]> = [];
		for (const entry of raw) {
			if (!Array.isArray(entry) || entry.length < 2) continue;
			const startRaw = entry[0];
			const endRaw = entry[1];
			if (typeof startRaw !== "number" || typeof endRaw !== "number")
				continue;
			const start = Math.max(0, Math.min(1, startRaw));
			const end = Math.max(0, Math.min(1, endRaw));
			if (end > start) intervals.push([start, end]);
		}
		return intervals;
	};
	for (const nodeId of nodeIds) {
		let attributes: string[] = [];
		try {
			const described = await dom.describeNode({ nodeId });
			attributes = described.node.attributes || [];
		} catch {
			continue;
		}

		const attributeMap = new Map<string, string>();
		for (let i = 0; i + 1 < attributes.length; i += 2) {
			attributeMap.set(attributes[i], attributes[i + 1]);
		}

		const rawBid = attributeMap.get("data-bid");
		if (!rawBid) continue;
		if (attributeMap.has("hidden")) continue;
		if (attributeMap.get(PRUNED_SKIP_ATTR) === "true") continue;

		const bidParts = splitBids(rawBid);
		const matchingBid = bidParts.find((bid) => requestedBidSet.has(bid));
		if (!matchingBid) continue;

		let minX: number | null = null;
		let minY: number | null = null;
		let maxX: number | null = null;
		let maxY: number | null = null;

		try {
			const { quads } = await dom.getContentQuads({ nodeId });
			for (const quad of quads || []) {
				for (let i = 0; i + 1 < quad.length; i += 2) {
					const x = quad[i];
					const y = quad[i + 1];
					minX = minX === null ? x : Math.min(minX, x);
					minY = minY === null ? y : Math.min(minY, y);
					maxX = maxX === null ? x : Math.max(maxX, x);
					maxY = maxY === null ? y : Math.max(maxY, y);
				}
			}
		} catch {
			// Fallback below.
		}

		if (minX === null || minY === null || maxX === null || maxY === null) {
			try {
				const { model } = await dom.getBoxModel({ nodeId });
				const border = model.border || [];
				for (let i = 0; i + 1 < border.length; i += 2) {
					const x = border[i];
					const y = border[i + 1];
					minX = minX === null ? x : Math.min(minX, x);
					minY = minY === null ? y : Math.min(minY, y);
					maxX = maxX === null ? x : Math.max(maxX, x);
					maxY = maxY === null ? y : Math.max(maxY, y);
				}
			} catch {
				continue;
			}
		}

		if (minX === null || minY === null || maxX === null || maxY === null) {
			continue;
		}

		const width = maxX - minX;
		const height = maxY - minY;
		if (!(width > 0 && height > 0)) continue;

		const firstBid = bidParts[0] || matchingBid;

		let visibleEdges = fullVisibleEdges;
		let visibleRatio = 1;
		try {
			const { object } = await dom.resolveNode({ nodeId });
			if (object.objectId) {
				const visibilityResponse = (await runtime.callFunctionOn({
					objectId: object.objectId,
					functionDeclaration: `function(bounds) {
            const target = this;
            if (!(target instanceof Element)) {
              return { top: [], bottom: [], left: [], right: [], visibleRatio: 0 };
            }
            const left = Number(bounds?.left || 0);
            const top = Number(bounds?.top || 0);
            const width = Number(bounds?.width || 0);
            const height = Number(bounds?.height || 0);
            if (!(width > 0 && height > 0)) {
              return { top: [], bottom: [], left: [], right: [], visibleRatio: 0 };
            }

            const sampleAlong = (count, fn) => {
              const out = [];
              const safeCount = Math.max(6, Math.min(96, Math.floor(count)));
              for (let i = 0; i < safeCount; i += 1) {
                out.push(Boolean(fn((i + 0.5) / safeCount)));
              }
              return out;
            };
            const toIntervals = (values) => {
              const intervals = [];
              const n = values.length;
              let start = -1;
              for (let i = 0; i < n; i += 1) {
                if (values[i]) {
                  if (start < 0) start = i;
                } else if (start >= 0) {
                  intervals.push([start / n, i / n]);
                  start = -1;
                }
              }
              if (start >= 0) intervals.push([start / n, 1]);
              return intervals;
            };
            const visibleAt = (x, y) => {
              const stack = document.elementsFromPoint(x, y);
              for (const candidate of stack) {
                if (!(candidate instanceof Element)) continue;
                if (candidate.hasAttribute("data-ba-ignore")) continue;
                return candidate === target || target.contains(candidate);
              }
              return false;
            };
            const inset = 1;
            const edgeSampleCountX = Math.max(8, Math.round(width / 20));
            const edgeSampleCountY = Math.max(8, Math.round(height / 20));
            const topY = top + inset;
            const bottomY = top + height - inset;
            const leftX = left + inset;
            const rightX = left + width - inset;
            const topSamples = sampleAlong(edgeSampleCountX, (t) => visibleAt(left + t * width, topY));
            const bottomSamples = sampleAlong(edgeSampleCountX, (t) => visibleAt(left + t * width, bottomY));
            const leftSamples = sampleAlong(edgeSampleCountY, (t) => visibleAt(leftX, top + t * height));
            const rightSamples = sampleAlong(edgeSampleCountY, (t) => visibleAt(rightX, top + t * height));

            const gridX = 5;
            const gridY = 5;
            let visibleInterior = 0;
            const totalInterior = gridX * gridY;
            for (let yi = 0; yi < gridY; yi += 1) {
              for (let xi = 0; xi < gridX; xi += 1) {
                const x = left + ((xi + 0.5) / gridX) * width;
                const y = top + ((yi + 0.5) / gridY) * height;
                if (visibleAt(x, y)) visibleInterior += 1;
              }
            }

            return {
              top: toIntervals(topSamples),
              bottom: toIntervals(bottomSamples),
              left: toIntervals(leftSamples),
              right: toIntervals(rightSamples),
              visibleRatio: totalInterior > 0 ? visibleInterior / totalInterior : 0
            };
          }`,
					arguments: [
						{
							value: {
								left: minX,
								top: minY,
								width,
								height,
							},
						},
					],
					returnByValue: true,
				})) as { result?: { value?: unknown } };
				const rawVisibility = visibilityResponse?.result?.value as
					| RawEdgeVisibilityResult
					| undefined;
				if (rawVisibility && typeof rawVisibility === "object") {
					const parsedEdges: EdgeVisibilityIntervals = {
						top: toIntervals(rawVisibility.top),
						bottom: toIntervals(rawVisibility.bottom),
						left: toIntervals(rawVisibility.left),
						right: toIntervals(rawVisibility.right),
					};
					const ratio =
						typeof rawVisibility.visibleRatio === "number" &&
						Number.isFinite(rawVisibility.visibleRatio)
							? Math.max(
									0,
									Math.min(1, rawVisibility.visibleRatio),
								)
							: 0;
					visibleEdges = parsedEdges;
					visibleRatio = ratio;
				}
			}
		} catch {
			// Fall back to fully-visible border rendering for this node.
		}

		out.push({
			bid: firstBid,
			color: pickColor(firstBid),
			viewportLeft: minX,
			viewportTop: minY,
			docLeft: minX + scrollX,
			docTop: minY + scrollY,
			width,
			height,
			visibleRatio,
			visibleEdges,
		});
	}

	return out;
}

async function drawBidOverlayOnScreenshot(params: {
	base64Image: string;
	format: CaptureScreenshotParams["format"];
	quality: CaptureScreenshotParams["quality"];
	captureParams: CaptureScreenshotParams;
	boxes: BidOverlayBox[];
}): Promise<string> {
	if (!params.base64Image || params.boxes.length === 0) {
		return params.base64Image;
	}
	try {
		const inputBuffer = Buffer.from(params.base64Image, "base64");
		const image = sharp(inputBuffer, { failOn: "none" });
		const metadata = await image.metadata();
		const width = metadata.width;
		const height = metadata.height;
		if (
			typeof width !== "number" ||
			typeof height !== "number" ||
			width <= 0 ||
			height <= 0
		) {
			return params.base64Image;
		}

		const clipX = params.captureParams.clip?.x ?? 0;
		const clipY = params.captureParams.clip?.y ?? 0;
		const useDocumentCoords =
			params.captureParams.captureBeyondViewport === true &&
			!params.captureParams.clip;

		const commands: string[] = [];
		for (const box of params.boxes) {
			const sourceLeft = useDocumentCoords
				? box.docLeft
				: box.viewportLeft;
			const sourceTop = useDocumentCoords ? box.docTop : box.viewportTop;
			const x = sourceLeft - clipX;
			const y = sourceTop - clipY;
			const w = box.width;
			const h = box.height;
			if (!(w > 0 && h > 0)) continue;
			if (x + w <= 0 || y + h <= 0 || x >= width || y >= height) continue;

			const roundedX = Math.round(x) + 0.5;
			const roundedY = Math.round(y) + 0.5;
			const roundedW = Math.max(1, Math.round(w) - 1);
			const roundedH = Math.max(1, Math.round(h) - 1);
			const drawLineSegments = (
				intervals: Array<[number, number]>,
				orientation: "h" | "v",
				constant: number,
			) => {
				for (const [start, end] of intervals) {
					if (!(end > start)) continue;
					if (orientation === "h") {
						const x1 = roundedX + start * roundedW;
						const x2 = roundedX + end * roundedW;
						commands.push(
							`<line x1="${x1}" y1="${constant}" x2="${x2}" y2="${constant}" stroke="${box.color}" stroke-width="2"/>`,
						);
					} else {
						const y1 = roundedY + start * roundedH;
						const y2 = roundedY + end * roundedH;
						commands.push(
							`<line x1="${constant}" y1="${y1}" x2="${constant}" y2="${y2}" stroke="${box.color}" stroke-width="2"/>`,
						);
					}
				}
			};
			const hasVisibleEdge =
				box.visibleEdges.top.length > 0 ||
				box.visibleEdges.bottom.length > 0 ||
				box.visibleEdges.left.length > 0 ||
				box.visibleEdges.right.length > 0;
			if (!hasVisibleEdge || box.visibleRatio <= 0) {
				continue;
			}
			drawLineSegments(box.visibleEdges.top, "h", roundedY);
			drawLineSegments(box.visibleEdges.bottom, "h", roundedY + roundedH);
			drawLineSegments(box.visibleEdges.left, "v", roundedX);
			drawLineSegments(box.visibleEdges.right, "v", roundedX + roundedW);

			const label = escapeXml(box.bid);
			const labelWidth = Math.max(18, Math.round(7 * box.bid.length + 8));
			const labelHeight = 16;
			const labelX = Math.max(
				0,
				Math.min(width - labelWidth, Math.round(x)),
			);
			const preferredLabelY = Math.round(y) - labelHeight;
			const labelY =
				preferredLabelY >= 0
					? preferredLabelY
					: Math.max(
							0,
							Math.min(height - labelHeight, Math.round(y)),
						);
			const textX = labelX + 4;
			const textY = labelY + 12;
			commands.push(
				`<rect x="${labelX}" y="${labelY}" width="${labelWidth}" height="${labelHeight}" rx="3" ry="3" fill="${box.color}"/>`,
				`<text x="${textX}" y="${textY}" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="11" fill="#ffffff">${label}</text>`,
			);
		}

		if (commands.length === 0) {
			return params.base64Image;
		}

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${commands.join("")}</svg>`;
		let pipeline = image.composite([
			{ input: Buffer.from(svg), top: 0, left: 0 },
		]);
		const normalizedFormat = normalizeScreenshotFormat(params.format);
		const encodedQuality =
			typeof params.quality === "number" &&
			Number.isFinite(params.quality)
				? Math.max(1, Math.min(100, Math.round(params.quality)))
				: 80;
		if (normalizedFormat === "jpeg") {
			pipeline = pipeline.jpeg({ quality: encodedQuality });
		} else if (normalizedFormat === "webp") {
			pipeline = pipeline.webp({ quality: encodedQuality });
		} else {
			pipeline = pipeline.png();
		}
		const output = await pipeline.toBuffer();
		if (output.length > 0) {
			return output.toString("base64");
		}
	} catch {
		// Best effort only: keep original screenshot on drawing failure.
	}
	return params.base64Image;
}

async function clearAndApplyBidBorders(
	runtime: RuntimeDomain,
	bids: string[],
): Promise<void> {
	await runtime.evaluate({
		expression: `(() => {
      const markerAttr = "${BORDER_MARKER_ATTR}";
      const previousStyleAttr = "${PREVIOUS_STYLE_ATTR}";
      const labelMarkerAttr = "${LABEL_MARKER_ATTR}";
      const prunedSkipAttr = "${PRUNED_SKIP_ATTR}";
      const ignoreAttr = "${IGNORE_ATTR}";
      const requestedBids = ${JSON.stringify(bids)};
      const requestedBidSet = new Set(requestedBids);
      const palette = ${JSON.stringify(BORDER_PALETTE)};

      const splitBids = (raw) =>
        String(raw || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);

      const pickColor = (bid) => {
        let hash = 0;
        for (let i = 0; i < bid.length; i += 1) {
          hash = (hash * 31 + bid.charCodeAt(i)) | 0;
        }
        return palette[Math.abs(hash) % palette.length];
      };

      const shouldSkipBidBorder = (el) => {
        if (el.getAttribute(prunedSkipAttr) === "true") return true;
        if (el.hasAttribute("hidden")) return true;
        const style = window.getComputedStyle(el);
        if (style.display === "none") return true;
        if (style.visibility === "hidden" || style.visibility === "collapse") return true;
        if (Number.parseFloat(style.opacity || "1") === 0) return true;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return true;
        return false;
      };

      const allBidElements = Array.from(document.querySelectorAll("[data-bid]"));
      const allInjectedLabels = Array.from(
        document.querySelectorAll("[" + labelMarkerAttr + '="true"]'),
      );

      for (const label of allInjectedLabels) {
        label.remove();
      }

      for (const el of allBidElements) {
        if (!el.hasAttribute(markerAttr)) continue;
        if (el.hasAttribute(previousStyleAttr)) {
          el.setAttribute("style", el.getAttribute(previousStyleAttr) || "");
          el.removeAttribute(previousStyleAttr);
        } else {
          el.removeAttribute("style");
        }
        el.removeAttribute(markerAttr);
      }

      if (requestedBidSet.size === 0) return;

      for (const el of allBidElements) {
        const dataBid = el.getAttribute("data-bid");
        if (!dataBid) continue;
        const bidParts = splitBids(dataBid);
        const matchingBid = bidParts.find((bid) => requestedBidSet.has(bid));
        if (!matchingBid) continue;
        if (shouldSkipBidBorder(el)) continue;

        if (el.hasAttribute("style")) {
          el.setAttribute(previousStyleAttr, el.getAttribute("style") || "");
        } else {
          el.removeAttribute(previousStyleAttr);
        }

        const firstBid = bidParts[0] || matchingBid;
        const color = pickColor(firstBid);
        el.style.setProperty("outline", "2px solid " + color, "important");
        el.style.setProperty("outline-offset", "-1px", "important");
        el.style.setProperty("box-shadow", "inset 0 0 0 1px " + color, "important");
        const computedStyle = window.getComputedStyle(el);
        if (computedStyle.position === "static") {
          el.style.setProperty("position", "relative", "important");
        }

        const label = document.createElement("span");
        label.textContent = firstBid;
        label.setAttribute(labelMarkerAttr, "true");
        label.setAttribute(ignoreAttr, "true");
        label.style.setProperty("position", "absolute", "important");
        label.style.setProperty("top", "0", "important");
        label.style.setProperty("left", "0", "important");
        label.style.setProperty("transform", "translate(0, -100%)", "important");
        label.style.setProperty("z-index", "2147483647", "important");
        label.style.setProperty("padding", "1px 4px", "important");
        label.style.setProperty("background", color, "important");
        label.style.setProperty("color", "#ffffff", "important");
        label.style.setProperty("font-size", "11px", "important");
        label.style.setProperty("line-height", "1.2", "important");
        label.style.setProperty(
          "font-family",
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          "important",
        );
        label.style.setProperty("border-radius", "3px", "important");
        label.style.setProperty("pointer-events", "none", "important");
        label.style.setProperty("white-space", "nowrap", "important");
        try {
          el.prepend(label);
        } catch {
          // Ignore cases where the element rejects child nodes.
        }
        el.setAttribute(markerAttr, "true");
      }
    })()`,
		awaitPromise: true,
	});
}

export async function captureScreenshotWithBidBorders(
	params: CaptureScreenshotWithBidBordersParams,
): Promise<string> {
	const bids = normalizeBids(params.bids || []);
	const shouldMutateDom = params.keepBordersInDom === true;
	const logCaptureDebug = shouldLogCaptureDebug();
	let activeBefore: ActiveElementSnapshot | null = null;
	if (logCaptureDebug) {
		activeBefore = await getActiveElementSnapshot(params.runtime);
	}
	if (shouldMutateDom) {
		await clearAndApplyBidBorders(params.runtime, bids);
	}
	try {
		const overlayBoxes = shouldMutateDom
			? []
			: await timeCapturePipelinePhase(
					"collectBidOverlayBoxes",
					async () =>
						await collectBidOverlayBoxes(
							params.dom,
							params.runtime,
							bids,
						),
					(result) =>
						`requested_bids=${bids.length} overlay_boxes=${result.length}`,
				);
		const devicePixelRatio = await timeCapturePipelinePhase(
			"getWindowDevicePixelRatio",
			async () => await getWindowDevicePixelRatio(params.runtime),
			(result) => `device_pixel_ratio=${result}`,
		);
		const captureAndMaybeDownsample = async (
			captureParams: CaptureScreenshotParams,
		): Promise<string> => {
			const captured = await timeCapturePipelinePhase(
				"Page.captureScreenshot",
				async () => await params.page.captureScreenshot(captureParams),
				(result) =>
					`format=${captureParams.format ?? "png"} capture_b64_chars=${result.data.length}`,
			);
			const downsampled = await timeCapturePipelinePhase(
				"downsampleScreenshotByFactor",
				async () =>
					await downsampleScreenshotByFactor({
						base64Image: captured.data,
						format: captureParams.format,
						quality: captureParams.quality,
						devicePixelRatio,
					}),
				(result) => `downsampled_b64_chars=${result.length}`,
			);
			if (shouldMutateDom || overlayBoxes.length === 0) {
				return downsampled;
			}
			return await timeCapturePipelinePhase(
				"drawBidOverlayOnScreenshot",
				async () =>
					await drawBidOverlayOnScreenshot({
						base64Image: downsampled,
						format: captureParams.format,
						quality: captureParams.quality,
						captureParams,
						boxes: overlayBoxes,
					}),
				(result) =>
					`overlay_boxes=${overlayBoxes.length} composited_b64_chars=${result.length}`,
			);
		};
		const captureViewportFallback = async (): Promise<string> => {
			return await captureAndMaybeDownsample({
				...params.captureScreenshotParams,
				captureBeyondViewport: false,
			});
		};

		const initial = await captureAndMaybeDownsample(
			params.captureScreenshotParams,
		);
		const canViewportFallback =
			params.captureScreenshotParams.captureBeyondViewport === true &&
			!params.captureScreenshotParams.clip;
		// Some pages return empty bytes for full-page capture; retry with viewport-only capture before failing.
		if (!hasScreenshotBytes(initial)) {
			if (canViewportFallback) {
				const fallbackImage = await captureViewportFallback();
				if (hasScreenshotBytes(fallbackImage)) {
					return fallbackImage;
				}
				throw new Error(
					"captureScreenshotWithBidBorders returned empty screenshot bytes for both initial full-page and viewport fallback captures",
				);
			}
			throw new Error(
				"captureScreenshotWithBidBorders returned empty screenshot bytes for the initial capture",
			);
		}
		const dimensions = parseScreenshotDimensions(
			initial,
			params.captureScreenshotParams.format,
		);
		const shouldFallbackToViewport =
			canViewportFallback &&
			Boolean(dimensions && dimensions.height > MAX_SCREENSHOT_HEIGHT_PX);
		// Avoid returning extremely tall full-page images that are likely to exceed downstream limits.
		if (!shouldFallbackToViewport) {
			return initial;
		}
		const fallbackImage = await captureViewportFallback();
		if (hasScreenshotBytes(fallbackImage)) {
			return fallbackImage;
		}
		throw new Error(
			"captureScreenshotWithBidBorders returned empty screenshot bytes for both initial and fallback captures",
		);
	} finally {
		if (shouldMutateDom && !params.keepBordersInDom) {
			await clearAndApplyBidBorders(params.runtime, []);
		}
		if (logCaptureDebug) {
			const activeAfter = await getActiveElementSnapshot(params.runtime);
			const changed =
				JSON.stringify(activeBefore) !== JSON.stringify(activeAfter);
			console.log(
				`[screenshot-debug] capture keepBordersInDom=${params.keepBordersInDom === true} active_before="${formatActiveElementSnapshot(activeBefore)}" active_after="${formatActiveElementSnapshot(activeAfter)}" active_changed=${changed}`,
			);
		}
	}
}
