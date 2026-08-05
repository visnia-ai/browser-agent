import * as fs from "fs";
import type Protocol from "devtools-protocol";
import type { Browser } from "./types.js";
import {
	STEPS_DIR,
	CONTEXT_DIR,
	SKIP_TAGS,
	KEEP_ATTRS,
	STYLE_BACKGROUND_IMAGE,
} from "./constants.js";
import { shouldSaveStepsContext } from "../runtime-options.js";
import { normalizeAriaLabelIntoText } from "./simplify-dom-utils/normalize-aria-label-into-text.js";
import { collapseRedundantDivLabelChildren } from "./simplify-dom-utils/collapse-redundant-div-label-children.js";
import { mergeSingleChildBidChains } from "./simplify-dom-utils/merge-single-child-bid-chains.js";
import { removeRedundantSingleTextChild } from "./simplify-dom-utils/remove-redundant-single-text-child.js";
import { runFinalTransparentWrapperHoist } from "./simplify-dom-utils/final-hoist-transparent-same-tag-wrappers.js";
import { serializeSimplifiedNode } from "./simplify-dom-utils/serialize-simplified-node.js";
import { normalizeTitleAttrIntoText } from "./simplify-dom-utils/normalize-title-attr-into-text.js";
import {
	buildChildrenOf,
	buildClickableSet,
	buildLayoutByNode,
	createDomSnapshotHelpers,
	type DomSnapshotHelpers,
	findBodyNodeIndex,
} from "./simplify-dom-utils/dom-snapshot-helpers.js";
import { pruneLargeHiddenHierarchies } from "./simplify-dom-utils/prune-large-hidden-hierarchies.js";
import { discardEmptyBidHierarchies } from "./simplify-dom-utils/discard-empty-bid-hierarchies.js";
import {
	stampDataBidsOnLiveDom,
	stampDataNonClickableIdsOnLiveDom,
	type BidStamp,
	type NonClickableIdStamp,
} from "./simplify-dom-utils/stamp-data-bids-on-live-dom.js";
import type { SimplifiedNode } from "./simplify-dom-utils/simplified-node.js";
import { shouldLogTimingDuration } from "../timing-logs.js";

export { CONTEXT_DIR, pruneLargeHiddenHierarchies };

export interface SimplifyDomOptions {
	includeNonClickableIds?: boolean;
	omitHrefs?: boolean;
	preserveFullHrefs?: boolean;
	hideOffscreenContent?: boolean;
	discardEmptyBids?: boolean;
	redactInputBids?: string[];
	redactPasswordInputs?: boolean;
	stepNumber?: number;
}

const IRRELEVANCE_PRUNED_MESSAGE = "Content pruned.";
const MAX_IFRAME_ATTRIBUTE_VALUE_LENGTH = 1000;
const REDACTED_INPUT_VALUE = "[REDACTED]";
const MAX_FALLBACK_PREVIEW_LENGTH = 280;
const MAX_FALLBACK_LINE_LENGTH = 400;

interface ViewportCullBounds {
	viewportTop: number;
	viewportBottom: number;
	overscanTop: number;
	overscanBottom: number;
}

interface OutsideViewport {
	direction: "above" | "below";
	scrollDeltaY: number;
}

type DownloadableHint = "true" | "false" | "unknown";

interface FallbackPageContext {
	url: string;
	title: string;
	contentType: string;
	resourceUrl: string;
	resourceContent: string;
	resourceContentIsBase64: boolean;
	viewerTags: string[];
	bodyText: string;
}

function logSimplifyDomPhase(params: {
	stepNumber?: number;
	phase: string;
	durationMs: number;
	status?: "ok" | "error";
	detail?: string;
}): void {
	const status = params.status ?? "ok";
	if (!shouldLogTimingDuration(params.durationMs, status)) {
		return;
	}
	const prefix =
		typeof params.stepNumber === "number"
			? `  [step ${params.stepNumber} simplify-dom]`
			: "  [simplify-dom]";
	const detail = params.detail ? ` | ${params.detail}` : "";
	console.log(
		`${prefix} ${params.phase} status=${status} duration_ms=${params.durationMs}${detail}`,
	);
}

async function timeSimplifyDomPhase<T>(
	params: {
		stepNumber?: number;
		phase: string;
		detail?: () => string | undefined;
	},
	fn: () => Promise<T>,
): Promise<T> {
	const startedAt = Date.now();
	try {
		const result = await fn();
		logSimplifyDomPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "ok",
			detail: params.detail?.(),
		});
		return result;
	} catch (error) {
		logSimplifyDomPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "error",
			detail: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

function timeSimplifyDomPhaseSync<T>(
	params: {
		stepNumber?: number;
		phase: string;
		detail?: () => string | undefined;
	},
	fn: () => T,
): T {
	const startedAt = Date.now();
	try {
		const result = fn();
		logSimplifyDomPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "ok",
			detail: params.detail?.(),
		});
		return result;
	} catch (error) {
		logSimplifyDomPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "error",
			detail: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

function normalizeHrefAttrValue(
	value: string,
	isWikipediaWebsite: boolean,
): string {
	if (isWikipediaWebsite) return "";
	const normalized = value.toLowerCase().replace(/\s+/g, "");
	return normalized.includes("javascript:void(0)") ? "" : value;
}

function getSnapshotString(strings: string[], idx: number | undefined): string {
	if (idx === undefined || idx < 0 || idx >= strings.length) return "";
	return strings[idx] || "";
}

async function getViewportCullBounds(
	b: Browser,
): Promise<ViewportCullBounds | undefined> {
	try {
		const metrics = await b.Page.getLayoutMetrics();
		const viewport = metrics.cssVisualViewport;
		const viewportTop = viewport.pageY;
		const viewportHeight = viewport.clientHeight;
		if (
			!Number.isFinite(viewportTop) ||
			!Number.isFinite(viewportHeight) ||
			viewportHeight <= 0
		) {
			return undefined;
		}
		const viewportBottom = viewportTop + viewportHeight;
		return {
			viewportTop,
			viewportBottom,
			overscanTop: viewportTop - viewportHeight * 0.5,
			overscanBottom: viewportBottom + viewportHeight * 0.5,
		};
	} catch {
		return undefined;
	}
}

function buildDocumentRootOffsetY(
	documents: Protocol.DOMSnapshot.DocumentSnapshot[],
): Map<number, number> {
	const offsets = new Map<number, number>([[0, 0]]);
	let changed = true;

	while (changed) {
		changed = false;
		for (
			let parentDocumentIndex = 0;
			parentDocumentIndex < documents.length;
			parentDocumentIndex++
		) {
			const parentOffset = offsets.get(parentDocumentIndex);
			if (parentOffset === undefined) continue;
			const parentDocument = documents[parentDocumentIndex];
			const contentDocuments = parentDocument.nodes.contentDocumentIndex;
			if (!contentDocuments) continue;
			const layoutByNode = buildLayoutByNode(parentDocument.layout);

			for (let i = 0; i < contentDocuments.index.length; i++) {
				const childDocumentIndex = contentDocuments.value[i];
				if (offsets.has(childDocumentIndex)) continue;
				const ownerNodeIndex = contentDocuments.index[i];
				const ownerLayoutIndex = layoutByNode.get(ownerNodeIndex);
				if (ownerLayoutIndex === undefined) continue;
				const ownerBounds =
					parentDocument.layout.bounds[ownerLayoutIndex];
				const ownerTop = ownerBounds?.[1];
				const childDocument = documents[childDocumentIndex];
				if (!Number.isFinite(ownerTop) || !childDocument) continue;
				const childScrollOffsetY = childDocument.scrollOffsetY ?? 0;
				offsets.set(
					childDocumentIndex,
					parentOffset + ownerTop - childScrollOffsetY,
				);
				changed = true;
			}
		}
	}

	return offsets;
}

function getDocumentUrl(
	doc: Protocol.DOMSnapshot.DocumentSnapshot,
	strings: string[],
): string {
	return (
		getSnapshotString(strings, doc.documentURL) ||
		getSnapshotString(strings, doc.baseURL)
	);
}

function isWikipediaWebsiteUrl(rawUrl: string): boolean {
	if (!rawUrl) return false;
	try {
		const hostname = new URL(rawUrl).hostname.toLowerCase();
		return (
			hostname === "wikipedia.org" || hostname.endsWith(".wikipedia.org")
		);
	} catch {
		return false;
	}
}

function sanitizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateWithEllipsis(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function escapeAttributeValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function toInlineValue(
	text: string,
	maxLength = MAX_FALLBACK_LINE_LENGTH,
): string {
	return truncateWithEllipsis(sanitizeWhitespace(text), maxLength);
}

function getPathExtension(rawUrl: string): string {
	if (!rawUrl) return "";
	try {
		const parsed = new URL(rawUrl);
		const pathname = parsed.pathname || "";
		const dotIndex = pathname.lastIndexOf(".");
		if (dotIndex < 0 || dotIndex === pathname.length - 1) return "";
		return pathname.slice(dotIndex + 1).toLowerCase();
	} catch {
		return "";
	}
}

function inferContentTypeFromUrl(rawUrl: string): string {
	const extension = getPathExtension(rawUrl);
	switch (extension) {
		case "pdf":
			return "application/pdf";
		case "json":
			return "application/json";
		case "csv":
			return "text/csv";
		case "txt":
			return "text/plain";
		case "xml":
			return "application/xml";
		case "yaml":
		case "yml":
			return "application/yaml";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		case "svg":
			return "image/svg+xml";
		case "avif":
			return "image/avif";
		case "mp3":
			return "audio/mpeg";
		case "wav":
			return "audio/wav";
		case "ogg":
			return "audio/ogg";
		case "m4a":
			return "audio/mp4";
		case "mp4":
			return "video/mp4";
		case "mov":
			return "video/quicktime";
		case "webm":
			return "video/webm";
		case "zip":
			return "application/zip";
		default:
			return "unknown";
	}
}

function normalizeContentType(
	rawContentType: string,
	fallbackUrl: string,
): string {
	const trimmed = rawContentType.trim().toLowerCase();
	if (trimmed) return trimmed;
	const inferred = inferContentTypeFromUrl(fallbackUrl);
	return inferred || "unknown";
}

function isTextualContentType(contentType: string): boolean {
	const type = contentType.toLowerCase();
	return (
		type.startsWith("text/") ||
		type.includes("json") ||
		type.includes("xml") ||
		type.includes("csv") ||
		type.includes("yaml") ||
		type.includes("javascript") ||
		type.includes("x-www-form-urlencoded")
	);
}

function detectDownloadableHint(
	contentType: string,
	extension: string,
): DownloadableHint {
	const type = contentType.toLowerCase();
	if (!type || type === "unknown") {
		if (extension) {
			const downloadableExts = new Set([
				"pdf",
				"zip",
				"gz",
				"tar",
				"mp3",
				"wav",
				"ogg",
				"m4a",
				"mp4",
				"mov",
				"webm",
				"jpg",
				"jpeg",
				"png",
				"gif",
				"webp",
				"avif",
			]);
			return downloadableExts.has(extension) ? "true" : "unknown";
		}
		return "unknown";
	}
	if (isTextualContentType(type)) return "false";
	if (
		type.startsWith("image/") ||
		type.startsWith("audio/") ||
		type.startsWith("video/") ||
		type === "application/pdf" ||
		type === "application/octet-stream" ||
		type === "application/zip"
	) {
		return "true";
	}
	return "unknown";
}

function deriveFileName(rawUrl: string): string {
	if (!rawUrl) return "";
	try {
		const pathname = new URL(rawUrl).pathname || "";
		const last = pathname.split("/").filter(Boolean).pop() || "";
		return last ? decodeURIComponent(last) : "";
	} catch {
		return "";
	}
}

function estimateContentBytes(content: string, isBase64: boolean): number {
	if (!content) return 0;
	if (isBase64) {
		try {
			return Buffer.from(content, "base64").byteLength;
		} catch {
			return 0;
		}
	}
	return Buffer.byteLength(content, "utf-8");
}

async function collectFallbackPageContext(
	b: Browser,
): Promise<FallbackPageContext> {
	let runtimeContext: Partial<FallbackPageContext> = {};
	try {
		const { result } = await b.Runtime.evaluate({
			expression: `(() => {
				const viewerTags = [];
				for (const tag of ["embed", "object", "img", "audio", "video", "pre"]) {
					if (document.querySelector(tag)) viewerTags.push(tag);
				}
				return {
					url: typeof location?.href === "string" ? location.href : "",
					title: typeof document?.title === "string" ? document.title : "",
					contentType: typeof document?.contentType === "string" ? document.contentType : "",
					viewerTags,
					bodyText:
						typeof document?.body?.innerText === "string"
							? document.body.innerText
							: "",
				};
			})()`,
			returnByValue: true,
		});
		if (result.value && typeof result.value === "object") {
			runtimeContext = result.value as Partial<FallbackPageContext>;
		}
	} catch {
		// Best effort fallback context only.
	}

	let resourceUrl = "";
	let resourceContent = "";
	let resourceContentIsBase64 = false;
	try {
		const { frameTree } = await b.Page.getResourceTree();
		const frameId = frameTree?.frame?.id;
		resourceUrl = frameTree?.frame?.url || "";
		if (frameId && resourceUrl) {
			try {
				const resource = await b.Page.getResourceContent({
					frameId,
					url: resourceUrl,
				});
				resourceContent = resource.content || "";
				resourceContentIsBase64 = resource.base64Encoded === true;
			} catch {
				// Content may be unavailable for non-text resources.
			}
		}
	} catch {
		// Resource tree may be unavailable in some environments.
	}

	const viewerTags = Array.isArray(runtimeContext.viewerTags)
		? runtimeContext.viewerTags.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
		: [];

	return {
		url:
			typeof runtimeContext.url === "string"
				? runtimeContext.url
				: resourceUrl,
		title:
			typeof runtimeContext.title === "string"
				? runtimeContext.title
				: "",
		contentType:
			typeof runtimeContext.contentType === "string"
				? runtimeContext.contentType
				: "",
		resourceUrl,
		resourceContent,
		resourceContentIsBase64,
		viewerTags,
		bodyText:
			typeof runtimeContext.bodyText === "string"
				? runtimeContext.bodyText
				: "",
	};
}

function decodeTextPreview(content: string, base64Encoded: boolean): string {
	if (!content) return "";
	if (!base64Encoded) return content;
	try {
		return Buffer.from(content, "base64").toString("utf-8");
	} catch {
		return "";
	}
}

async function buildNonHtmlFallbackSnapshot(b: Browser): Promise<string> {
	const ctx = await collectFallbackPageContext(b);
	const canonicalUrl = ctx.url || ctx.resourceUrl || "";
	const contentType = normalizeContentType(
		ctx.contentType || "",
		canonicalUrl,
	);
	const extension = getPathExtension(canonicalUrl);
	const fileName = deriveFileName(canonicalUrl);
	const downloadable = detectDownloadableHint(contentType, extension);
	const textual = isTextualContentType(contentType);
	const previewSource = textual
		? decodeTextPreview(ctx.resourceContent, ctx.resourceContentIsBase64) ||
			ctx.bodyText
		: "";
	const preview = previewSource
		? toInlineValue(previewSource, MAX_FALLBACK_PREVIEW_LENGTH)
		: "";

	const metadataParts: string[] = [];
	if (contentType) metadataParts.push(`content-type=${contentType}`);
	if (extension) metadataParts.push(`extension=${extension}`);
	if (ctx.viewerTags.length > 0) {
		metadataParts.push(`viewer=${ctx.viewerTags.join(",")}`);
	}
	const resourceBytes = estimateContentBytes(
		ctx.resourceContent,
		ctx.resourceContentIsBase64,
	);
	if (resourceBytes > 0) metadataParts.push(`bytes=${resourceBytes}`);
	if (ctx.resourceUrl && ctx.resourceUrl !== canonicalUrl) {
		metadataParts.push(`resource=${ctx.resourceUrl}`);
	}

	const rootAttrs = [
		`kind="non-html-fallback"`,
		`content-type="${escapeAttributeValue(contentType || "unknown")}"`,
		`downloadable="${downloadable}"`,
	];
	if (fileName) {
		rootAttrs.push(`file="${escapeAttributeValue(fileName)}"`);
	}

	const lines = [`file-view ${rootAttrs.join(" ")}`];
	if (canonicalUrl)
		lines.push(`  url: "${escapeAttributeValue(canonicalUrl)}"`);
	if (ctx.title.trim()) {
		lines.push(
			`  title: "${escapeAttributeValue(toInlineValue(ctx.title))}"`,
		);
	}
	if (ctx.viewerTags.length > 0) {
		lines.push(
			`  viewer: "${escapeAttributeValue(toInlineValue(ctx.viewerTags.join(",")))}"`,
		);
	}
	if (preview) {
		lines.push(`  preview: "${escapeAttributeValue(preview)}"`);
	} else {
		const metadata = toInlineValue(
			metadataParts.join("; ") || "no-preview-available",
		);
		lines.push(`  metadata: "${escapeAttributeValue(metadata)}"`);
	}
	return lines.join("\n");
}

function extractImageNameFromSrc(rawSrc: string): string | null {
	if (!rawSrc.trim()) return null;

	let pathname = "";
	try {
		pathname = new URL(rawSrc, "https://browser-agent.local").pathname;
	} catch {
		return null;
	}

	const segments = pathname
		.split("/")
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) return null;

	const candidate = segments[segments.length - 1];
	if (!candidate) return null;

	try {
		return decodeURIComponent(candidate);
	} catch {
		return candidate;
	}
}

function extractImageNameFromBackgroundImageValue(
	backgroundImageValue: string,
): string | null {
	if (!backgroundImageValue.trim()) return null;
	const matches = backgroundImageValue.matchAll(/url\(([^)]+)\)/gi);
	for (const match of matches) {
		const raw = (match[1] || "").trim();
		if (!raw) continue;
		const unquoted =
			(raw.startsWith('"') && raw.endsWith('"')) ||
			(raw.startsWith("'") && raw.endsWith("'"))
				? raw.slice(1, -1).trim()
				: raw;
		if (!unquoted) continue;
		const imageName = extractImageNameFromSrc(unquoted);
		if (imageName) return imageName;
	}
	return null;
}

function shouldIncludeImageNameInSimplifiedDom(
	imageName: string | null,
): imageName is string {
	return typeof imageName === "string" && imageName.length < 30;
}

/** Map heading tags to a single name so simplified DOM node labels never collide with base-36 bids (e.g. h4). */
function simplifiedDomElementTag(tag: string): string {
	if (/^H[1-6]$/i.test(tag)) return "title";
	return tag.toLowerCase();
}

function createIrrelevancePrunedPlaceholder(): SimplifiedNode {
	return {
		tag: "pruned",
		attrs: [],
		text: IRRELEVANCE_PRUNED_MESSAGE,
		children: [],
		isHidden: false,
		couldBeHidden: false,
		isInteractive: false,
	};
}

function collectExistingBids(
	nodeCount: number,
	getAttrs: DomSnapshotHelpers["getAttrs"],
): Set<string> {
	const existing = new Set<string>();
	for (let i = 0; i < nodeCount; i++) {
		const dataBid = getAttrs(i).get("data-bid");
		if (!dataBid) continue;
		for (const raw of dataBid.split(",")) {
			const bid = raw.trim();
			if (bid) existing.add(bid);
		}
	}
	return existing;
}

function collectExistingNonClickableIds(
	nodeCount: number,
	getAttrs: DomSnapshotHelpers["getAttrs"],
): Set<string> {
	const existing = new Set<string>();
	for (let i = 0; i < nodeCount; i++) {
		const id = getAttrs(i).get("data-nonclickableid");
		if (!id) continue;
		const trimmed = id.trim();
		if (trimmed) existing.add(trimmed);
	}
	return existing;
}

function createBidAllocator(existingBids: Set<string>): () => string {
	let counter = 0;
	for (const bid of existingBids) {
		if (!/^[a-z0-9]+$/i.test(bid)) continue;
		const parsed = Number.parseInt(bid, 36);
		if (Number.isFinite(parsed) && parsed >= counter) {
			counter = parsed + 1;
		}
	}

	return () => {
		while (true) {
			const candidate = (counter++).toString(36);
			if (existingBids.has(candidate)) continue;
			existingBids.add(candidate);
			return candidate;
		}
	};
}

function createNCBidAllocator(
	existingNonClickableIds: Set<string>,
	prefix = "!",
): () => string {
	const existingGeneratedIds = new Set<string>();
	const existingUnprefixedIds = new Set<string>();

	for (const rawId of existingNonClickableIds) {
		const id = rawId.trim();
		if (!id) continue;
		existingGeneratedIds.add(id);

		if (id.startsWith(prefix)) {
			const unprefixed = id.slice(prefix.length).trim();
			if (unprefixed) existingUnprefixedIds.add(unprefixed);
			continue;
		}

		existingUnprefixedIds.add(id);
	}

	const nextBid = createBidAllocator(existingUnprefixedIds);
	return () => {
		while (true) {
			const candidate = `${prefix}${nextBid()}`;
			if (existingGeneratedIds.has(candidate)) continue;
			existingGeneratedIds.add(candidate);
			return candidate;
		}
	};
}

interface BuildNodeContext {
	documentIndex: number;
	bodyNodeIndex: number;
	nodes: Protocol.DOMSnapshot.DocumentSnapshot["nodes"];
	strings: string[];
	nodeNames: number[];
	childrenOf: Map<number, number[]>;
	liveInputValuesByNodeIndex: Map<number, string>;
	bidStamps: BidStamp[];
	nonClickableIdStamps: NonClickableIdStamp[];
	getAttrs: DomSnapshotHelpers["getAttrs"];
	isHidden: DomSnapshotHelpers["isHidden"];
	couldBeHidden: DomSnapshotHelpers["couldBeHidden"];
	scrollEnabled: DomSnapshotHelpers["scrollEnabled"];
	getStyle: DomSnapshotHelpers["getStyle"];
	isInteractive: DomSnapshotHelpers["isInteractive"];
	noClickAllowedCursor: DomSnapshotHelpers["noClickAllowedCursor"];
	getRareString: DomSnapshotHelpers["getRareString"];
	getOutsideViewport: (nodeIndex: number) => OutsideViewport | undefined;
	scrollableByNodeIndex: Map<number, boolean>;
	nextBid: () => string;
	nextNonClickableId: () => string;
	includeNonClickableIds: boolean;
	preserveFullHrefs: boolean;
	hideOffscreenContent: boolean;
	redactInputBids: Set<string>;
	redactPasswordInputs: boolean;
	isWikipediaWebsite: boolean;
	allDocumentsByIndex: Map<number, BuildNodeContext>;
	activeDocumentIndexes: Set<number>;
}

interface PreparedDocumentContext {
	documentIndex: number;
	bodyNodeIndex: number;
	nodes: Protocol.DOMSnapshot.DocumentSnapshot["nodes"];
	strings: string[];
	nodeNames: number[];
	childrenOf: Map<number, number[]>;
	liveInputValuesByNodeIndex: Map<number, string>;
	getAttrs: DomSnapshotHelpers["getAttrs"];
	isHidden: DomSnapshotHelpers["isHidden"];
	couldBeHidden: DomSnapshotHelpers["couldBeHidden"];
	scrollEnabled: DomSnapshotHelpers["scrollEnabled"];
	getStyle: DomSnapshotHelpers["getStyle"];
	isInteractive: DomSnapshotHelpers["isInteractive"];
	noClickAllowedCursor: DomSnapshotHelpers["noClickAllowedCursor"];
	getRareString: DomSnapshotHelpers["getRareString"];
	getOutsideViewport: (nodeIndex: number) => OutsideViewport | undefined;
	scrollableByNodeIndex: Map<number, boolean>;
	isWikipediaWebsite: boolean;
}

function getRareInteger(
	rare: Protocol.DOMSnapshot.RareIntegerData | undefined,
	idx: number,
): number | undefined {
	if (!rare) return undefined;
	const pos = rare.index.indexOf(idx);
	return pos !== -1 ? rare.value[pos] : undefined;
}

function mergeIntoSet<T>(target: Set<T>, source: Set<T>): void {
	for (const value of source) target.add(value);
}

async function prepareDocumentContext(params: {
	b: Browser;
	doc: Protocol.DOMSnapshot.DocumentSnapshot;
	documentIndex: number;
	strings: string[];
	isWikipediaWebsite: boolean;
	documentRootOffsetY: number | undefined;
	viewportCullBounds: ViewportCullBounds | undefined;
}): Promise<PreparedDocumentContext> {
	const {
		b,
		doc,
		documentIndex,
		strings,
		isWikipediaWebsite,
		documentRootOffsetY,
		viewportCullBounds,
	} = params;
	const { nodes, layout } = doc;
	const nodeCount = nodes.nodeType?.length ?? 0;
	const layoutByNode = buildLayoutByNode(layout);
	const clickableSet = buildClickableSet(nodes);
	const childrenOf = buildChildrenOf(nodes.parentIndex, nodeCount);
	const nodeNames = nodes.nodeName ?? [];
	const bodyNodeIndex = findBodyNodeIndex(nodeCount, nodeNames, strings);
	const {
		getLiveInputValuesByNodeIndex,
		getScrollableByNodeIndex,
		getAttrs,
		isHidden,
		couldBeHidden,
		scrollEnabled,
		getStyle,
		isInteractive,
		noClickAllowedCursor,
		getRareString,
	} = createDomSnapshotHelpers({
		b,
		nodeCount,
		nodeNames,
		nodes,
		strings,
		layout,
		layoutByNode,
		clickableSet,
	});
	const liveInputValuesByNodeIndex = await getLiveInputValuesByNodeIndex();
	const scrollableByNodeIndex = await getScrollableByNodeIndex();
	const getOutsideViewport = (
		nodeIndex: number,
	): OutsideViewport | undefined => {
		if (!viewportCullBounds || documentRootOffsetY === undefined) {
			return undefined;
		}
		const layoutIndex = layoutByNode.get(nodeIndex);
		if (layoutIndex === undefined) return undefined;
		const bounds = layout.bounds[layoutIndex];
		const localTop = bounds?.[1];
		const height = bounds?.[3];
		if (
			!Number.isFinite(localTop) ||
			!Number.isFinite(height) ||
			height <= 0
		) {
			return undefined;
		}
		const top = documentRootOffsetY + localTop;
		const bottom = top + height;
		if (bottom < viewportCullBounds.overscanTop) {
			return {
				direction: "above",
				scrollDeltaY: Math.floor(
					bottom - viewportCullBounds.viewportTop,
				),
			};
		}
		if (top > viewportCullBounds.overscanBottom) {
			return {
				direction: "below",
				scrollDeltaY: Math.ceil(
					top - viewportCullBounds.viewportBottom,
				),
			};
		}
		return undefined;
	};

	return {
		documentIndex,
		bodyNodeIndex,
		nodes,
		strings,
		nodeNames,
		childrenOf,
		liveInputValuesByNodeIndex,
		getAttrs,
		isHidden,
		couldBeHidden,
		scrollEnabled,
		getStyle,
		isInteractive,
		noClickAllowedCursor,
		getRareString,
		getOutsideViewport,
		scrollableByNodeIndex,
		isWikipediaWebsite,
	};
}

function appendIframeDocumentChildren(
	nodeIndex: number,
	ctx: BuildNodeContext,
	appendChild: (child: SimplifiedNode) => void,
): void {
	const iframeDocumentIndex = getRareInteger(
		ctx.nodes.contentDocumentIndex,
		nodeIndex,
	);
	if (iframeDocumentIndex === undefined) return;

	const iframeCtx = ctx.allDocumentsByIndex.get(iframeDocumentIndex);
	if (!iframeCtx || iframeCtx.bodyNodeIndex < 0) return;
	if (ctx.activeDocumentIndexes.has(iframeDocumentIndex)) return;

	ctx.activeDocumentIndexes.add(iframeDocumentIndex);
	try {
		const iframeBody = buildNode(iframeCtx.bodyNodeIndex, iframeCtx);
		if (!iframeBody || typeof iframeBody === "string") return;
		if (iframeBody.tag === "body") {
			for (const child of iframeBody.children) appendChild(child);
			return;
		}
		appendChild(iframeBody);
	} finally {
		ctx.activeDocumentIndexes.delete(iframeDocumentIndex);
	}
}

function buildNode(
	i: number,
	ctx: BuildNodeContext,
	hasInteractiveAncestor = false,
): SimplifiedNode | string | null {
	const {
		nodes,
		strings,
		nodeNames,
		childrenOf,
		liveInputValuesByNodeIndex,
		bidStamps,
		nonClickableIdStamps,
		getAttrs,
		isHidden,
		couldBeHidden,
		scrollEnabled,
		getStyle,
		isInteractive,
		noClickAllowedCursor,
		getRareString,
		getOutsideViewport,
		scrollableByNodeIndex,
		nextBid,
		nextNonClickableId,
		includeNonClickableIds,
		preserveFullHrefs,
		redactInputBids,
		redactPasswordInputs,
	} = ctx;

	const nodeType = nodes.nodeType?.[i] ?? 0;

	// Text node
	if (nodeType === 3) {
		const valIdx = nodes.nodeValue?.[i];
		const t = valIdx !== undefined ? strings[valIdx] : "";

		if (!t) return null;
		return t.trim();
	}

	if (nodeType !== 1) return null;

	// Skip pseudo-elements (::before, ::after, etc.)
	if (getRareString(nodes.pseudoType, i)) return null;

	const tag = (strings[nodeNames[i]] || "").toUpperCase();
	if (SKIP_TAGS.has(tag)) return null;

	const attrMap = getAttrs(i);
	if (attrMap.get("data-ba-irrelevant-pruned") === "true") {
		// Exclude this subtree while keeping an explicit placeholder in output.
		return createIrrelevancePrunedPlaceholder();
	}
	if (tag === "INPUT") {
		const liveValue = liveInputValuesByNodeIndex.get(i);
		if (liveValue !== undefined) {
			attrMap.set("value", liveValue);
		}
	}
	if (tag === "INPUT" && attrMap.get("type") === "hidden") return null;
	if (attrMap.get("data-ba-ignore") === "true") return null; // Exclude browser-agent UI elements

	const existingBid = attrMap.get("data-bid");
	const inputType = (attrMap.get("type") || "").toLowerCase();
	const shouldRedactInputValue =
		tag === "INPUT" &&
		((redactPasswordInputs && inputType === "password") ||
			(existingBid ? redactInputBids.has(existingBid) : false));

	const hidden = isHidden(i);
	// Options follow select visibility; per-option layout uncertainty is noise in prompts.
	const maybeHidden = tag === "OPTION" ? false : !hidden && couldBeHidden(i);
	const interactive = !hidden && isInteractive(i, tag, attrMap);
	const inClickableHierarchy = interactive || hasInteractiveAncestor;
	const noClickAllowed = interactive && noClickAllowedCursor(i);
	const hasScrollEnabledOverflow = scrollEnabled(i);
	const scrollable = scrollableByNodeIndex.get(i) === true;
	const outsideViewport = getOutsideViewport(i);
	const allowBidOnNode = tag !== "BODY";

	// Recursively build children
	const kids = childrenOf.get(i) || [];
	const built = kids
		.map((childIdx) => buildNode(childIdx, ctx, inClickableHierarchy))
		.filter(Boolean) as (SimplifiedNode | string)[];

	const textParts: string[] = [];
	const elementChildren: SimplifiedNode[] = [];
	const parentTag = simplifiedDomElementTag(tag);
	const appendChild = (child: SimplifiedNode): void => {
		// Hoist transparent same-tag wrappers so sibling hierarchies stay distinct
		// without carrying redundant container levels.
		const isTransparentSameTagWrapper =
			child.tag === parentTag &&
			!child.isInteractive &&
			child.isHidden === hidden &&
			Boolean(child.couldBeHidden) === maybeHidden &&
			!child.text &&
			child.attrs.length === 0 &&
			child.children.length > 0;
		if (isTransparentSameTagWrapper) {
			for (const grandChild of child.children) appendChild(grandChild);
			return;
		}
		elementChildren.push(child);
	};
	for (const c of built) {
		if (typeof c === "string") textParts.push(c);
		else appendChild(c);
	}
	appendIframeDocumentChildren(i, ctx, appendChild);

	// Include input/textarea current values as text
	const inputVal =
		tag === "INPUT"
			? (liveInputValuesByNodeIndex.get(i) ??
				getRareString(nodes.inputValue, i))
			: getRareString(nodes.inputValue, i);
	if (inputVal) {
		textParts.push(
			shouldRedactInputValue ? REDACTED_INPUT_VALUE : inputVal,
		);
	}
	const textVal = getRareString(nodes.textValue, i);
	if (textVal) textParts.push(textVal);

	let text = textParts.join(" ");

	// Build kept attributes
	let attrs: [string, string][] = [];

	if (allowBidOnNode && interactive) {
		const bid = existingBid || nextBid();
		attrs.push(["bid", bid]);
		if (!existingBid) {
			const backendId = nodes.backendNodeId?.[i];
			if (backendId) bidStamps.push({ backendNodeId: backendId, bid });
		}
	} else if (allowBidOnNode && existingBid) {
		attrs.push(["bid", existingBid]);
	}

	for (const name of KEEP_ATTRS) {
		const rawValue = attrMap.get(name);
		if (rawValue === undefined) continue;
		const v =
			name === "href"
				? preserveFullHrefs
					? rawValue
					: normalizeHrefAttrValue(rawValue, ctx.isWikipediaWebsite)
				: rawValue;
		if (name !== "href" && !v) continue;
		if (name === "aria-label" && v.trim() === "") continue;
		if (name === "aria-label" && text && v.trim() === text.trim()) continue;
		attrs.push([
			name,
			name === "value" && shouldRedactInputValue
				? REDACTED_INPUT_VALUE
				: v,
		]);
	}

	const keepImageInClickableHierarchy = tag === "IMG" && inClickableHierarchy;

	if (keepImageInClickableHierarchy) {
		const rawSrc = attrMap.get("src");
		if (rawSrc !== undefined) {
			const imageName = extractImageNameFromSrc(rawSrc);

			if (shouldIncludeImageNameInSimplifiedDom(imageName)) {
				attrs.push(["src", imageName]);
			}
		}
	}

	const hasImageAttrAlready = attrs.some(
		([name]) => name === "img" || name === "src",
	);
	if (inClickableHierarchy && !hasImageAttrAlready) {
		const backgroundImageValue = getStyle(i, STYLE_BACKGROUND_IMAGE);
		const imageName =
			extractImageNameFromBackgroundImageValue(backgroundImageValue);
		if (shouldIncludeImageNameInSimplifiedDom(imageName)) {
			attrs.push(["img", imageName]);
		}
	}

	// Preserve slider bounds for range controls when present on the live DOM.
	if (
		tag === "INPUT" &&
		(attrMap.get("type") || "").toLowerCase() === "range"
	) {
		for (const name of ["min", "max"] as const) {
			if (!attrMap.has(name)) continue;
			const value = attrMap.get(name) ?? "";
			if (attrs.some(([existingName]) => existingName === name)) continue;
			attrs.push([name, value]);
		}
	}

	if (tag === "IFRAME") {
		attrs = attrs.filter(
			([, value]) => value.length <= MAX_IFRAME_ATTRIBUTE_VALUE_LENGTH,
		);
	}

	({ attrs, text } = normalizeAriaLabelIntoText(tag, attrs, text));

	if (tag === "OPTION") {
		// Always include `value`: it is what gets POSTed on form submit, what `HTMLSelectElement.value`
		// expects when scripting, and the stable id when labels repeat; omitting it breaks choosing
		// the right item without guesswork.
		const rawVal = attrMap.get("value");
		const v = rawVal !== undefined && rawVal !== null ? String(rawVal) : "";
		attrs = attrs.filter(([n]) => n !== "value");
		attrs.push(["value", v]);
	}

	const subtreeIsOutsideInSameDirection =
		outsideViewport !== undefined &&
		elementChildren.every(
			(child) =>
				child.outsideViewport?.direction === outsideViewport.direction,
		);
	if (
		ctx.hideOffscreenContent &&
		allowBidOnNode &&
		subtreeIsOutsideInSameDirection
	) {
		let markerBid = attrs.find(([name]) => name === "bid")?.[1];
		if (!markerBid) {
			const backendNodeId = nodes.backendNodeId?.[i];
			if (!backendNodeId) {
				markerBid = undefined;
			} else {
				markerBid = nextBid();
				bidStamps.push({ backendNodeId, bid: markerBid });
			}
		}
		if (markerBid) {
			return {
				tag: "content-hidden-outside-viewport",
				attrs: [["bid", markerBid]],
				text: "",
				children: [],
				isHidden: hidden,
				isInteractive: false,
				outsideViewport,
			};
		}
	}

	// Collapse wrappers only when they are fully transparent.
	if (attrs.length === 0 && !text && elementChildren.length === 1) {
		return elementChildren[0];
	}

	// Keep wrapper collapsing/null-pruning independent from optional non-clickable IDs.
	if (
		!text &&
		elementChildren.length === 0 &&
		attrs.length === 0 &&
		!(tag === "IMG" && hasInteractiveAncestor)
	)
		return null;

	if (
		includeNonClickableIds &&
		allowBidOnNode &&
		!interactive &&
		elementChildren.length > 0 &&
		!attrs.some(([name]) => name === "bid")
	) {
		const existingNonClickableId = attrMap.get("data-nonclickableid");
		const nonClickableId = existingNonClickableId || nextNonClickableId();
		attrs.push(["ncid", nonClickableId]);
		if (!existingNonClickableId) {
			const backendId = nodes.backendNodeId?.[i];
			if (backendId) {
				nonClickableIdStamps.push({
					backendNodeId: backendId,
					nonClickableId,
				});
			}
		}
	}

	return {
		tag: simplifiedDomElementTag(tag),
		attrs,
		text,
		children: elementChildren,
		isHidden: hidden,
		couldBeHidden: maybeHidden,
		isInteractive: interactive,
		...(noClickAllowed ? { noClickAllowed: true } : {}),
		...(hasScrollEnabledOverflow ? { scrollEnabled: true } : {}),
		...(scrollable ? { scrollable: true } : {}),
	};
}

/**
 * Uses DOMSnapshot.captureSnapshot to get a complete DOM snapshot including
 * shadow DOM, layout info, and computed styles. Rebuilds a simplified tree
 * and serializes it as indented YAML-like format.
 */
export async function getSimplifiedDOM(
	b: Browser,
	options: SimplifyDomOptions = {},
): Promise<string> {
	const stepNumber = options.stepNumber;
	const includeNonClickableIds = options.includeNonClickableIds === true;
	const omitHrefs = options.omitHrefs ?? true;
	const preserveFullHrefs = options.preserveFullHrefs === true;
	const hideOffscreenContent = options.hideOffscreenContent === true;
	const discardEmptyBids = options.discardEmptyBids !== false;
	const redactInputBids = new Set(
		(options.redactInputBids || [])
			.map((bid) => bid.trim())
			.filter(Boolean),
	);
	const redactPasswordInputs = options.redactPasswordInputs === true;
	const viewportCullBounds = hideOffscreenContent
		? await getViewportCullBounds(b)
		: undefined;
	let capturedDocumentCount = 0;
	const snap = await timeSimplifyDomPhase(
		{
			stepNumber,
			phase: "captureSnapshot",
			detail: () => `documents=${capturedDocumentCount}`,
		},
		async () => {
			const result = await b.DOMSnapshot.captureSnapshot({
				computedStyles: [
					"display",
					"visibility",
					"opacity",
					"cursor",
					"overflow-x",
					"overflow-y",
					"background-image",
				],
				includeDOMRects: true,
			});
			capturedDocumentCount = result.documents.length;
			return result;
		},
	);

	const { strings } = snap;
	if (snap.documents.length === 0) {
		return await buildNonHtmlFallbackSnapshot(b);
	}
	const rootDocumentUrl = getDocumentUrl(snap.documents[0], strings);
	const isWikipediaWebsite = isWikipediaWebsiteUrl(rootDocumentUrl);
	const documentRootOffsetsY = viewportCullBounds
		? buildDocumentRootOffsetY(snap.documents)
		: new Map<number, number>();

	const documentIndices = snap.documents.map((_, index) => index);

	let preparedDocuments: PreparedDocumentContext[] = [];
	preparedDocuments = await timeSimplifyDomPhase(
		{
			stepNumber,
			phase: "prepareDocumentContext",
			detail: () => `documents=${preparedDocuments.length}`,
		},
		async () => {
			preparedDocuments = await Promise.all(
				documentIndices.map((documentIndex) =>
					prepareDocumentContext({
						b,
						doc: snap.documents[documentIndex],
						documentIndex,
						strings,
						isWikipediaWebsite,
						documentRootOffsetY:
							documentRootOffsetsY.get(documentIndex),
						viewportCullBounds,
					}),
				),
			);
			return preparedDocuments;
		},
	);

	const bidStamps: BidStamp[] = [];
	const nonClickableIdStamps: NonClickableIdStamp[] = [];
	const allDocumentsByIndex = new Map<number, BuildNodeContext>();
	const activeDocumentIndexes = new Set<number>();
	let tree: SimplifiedNode | string | null = null;
	tree = timeSimplifyDomPhaseSync(
		{
			stepNumber,
			phase: "buildSimplifiedTree",
			detail: () =>
				`bid_stamps=${bidStamps.length} nonclickable_stamps=${nonClickableIdStamps.length}`,
		},
		() => {
			const existingBids = new Set<string>();
			const existingNonClickableIds = new Set<string>();
			for (const doc of preparedDocuments) {
				const nodeCount = doc.nodes.nodeType?.length ?? 0;
				mergeIntoSet(
					existingBids,
					collectExistingBids(nodeCount, doc.getAttrs),
				);
				mergeIntoSet(
					existingNonClickableIds,
					collectExistingNonClickableIds(nodeCount, doc.getAttrs),
				);
			}
			const nextBid = createBidAllocator(existingBids);
			const nextNonClickableId = createNCBidAllocator(
				existingNonClickableIds,
			);

			for (const doc of preparedDocuments) {
				allDocumentsByIndex.set(doc.documentIndex, {
					documentIndex: doc.documentIndex,
					bodyNodeIndex: doc.bodyNodeIndex,
					nodes: doc.nodes,
					strings: doc.strings,
					nodeNames: doc.nodeNames,
					childrenOf: doc.childrenOf,
					liveInputValuesByNodeIndex: doc.liveInputValuesByNodeIndex,
					bidStamps,
					nonClickableIdStamps,
					getAttrs: doc.getAttrs,
					isHidden: doc.isHidden,
					couldBeHidden: doc.couldBeHidden,
					scrollEnabled: doc.scrollEnabled,
					getStyle: doc.getStyle,
					isInteractive: doc.isInteractive,
					noClickAllowedCursor: doc.noClickAllowedCursor,
					getRareString: doc.getRareString,
					getOutsideViewport: doc.getOutsideViewport,
					scrollableByNodeIndex: doc.scrollableByNodeIndex,
					nextBid,
					nextNonClickableId,
					includeNonClickableIds,
					preserveFullHrefs,
					hideOffscreenContent,
					redactInputBids,
					redactPasswordInputs,
					isWikipediaWebsite: doc.isWikipediaWebsite,
					allDocumentsByIndex,
					activeDocumentIndexes,
				});
			}

			const rootDoc = allDocumentsByIndex.get(0);
			if (!rootDoc || rootDoc.bodyNodeIndex < 0) {
				return null;
			}

			activeDocumentIndexes.add(0);
			const result = buildNode(rootDoc.bodyNodeIndex, rootDoc);
			activeDocumentIndexes.delete(0);
			return result;
		},
	);
	if (!tree) {
		return await buildNonHtmlFallbackSnapshot(b);
	}

	const finalHoistedTree = timeSimplifyDomPhaseSync(
		{
			stepNumber,
			phase: "cleanupPostprocess",
		},
		() => {
			const mergedTree =
				typeof tree !== "string"
					? mergeSingleChildBidChains(tree)
					: tree;
			const titleNormalizedTree =
				typeof mergedTree !== "string"
					? normalizeTitleAttrIntoText(mergedTree)
					: mergedTree;
			const cleanedTree =
				typeof titleNormalizedTree !== "string"
					? collapseRedundantDivLabelChildren(titleNormalizedTree)
					: titleNormalizedTree;
			const textPrunedTree =
				typeof cleanedTree !== "string"
					? removeRedundantSingleTextChild(cleanedTree)
					: cleanedTree;

			// IMPORTANT: keep this final hoist pass here, right before serialization/stamping.
			// Earlier placement lets subsequent cleanup heuristics reintroduce redundant wrappers.
			const finalTree =
				typeof textPrunedTree !== "string"
					? runFinalTransparentWrapperHoist(textPrunedTree)
					: textPrunedTree;
			return discardEmptyBids && typeof finalTree !== "string"
				? discardEmptyBidHierarchies(finalTree)
				: finalTree;
		},
	);

	// Skip the body tag and serialize its children directly
	let yaml = "";
	yaml = timeSimplifyDomPhaseSync(
		{
			stepNumber,
			phase: "serialize",
			detail: () => `html_chars=${yaml.length}`,
		},
		() => {
			if (finalHoistedTree && typeof finalHoistedTree !== "string") {
				yaml = finalHoistedTree.children
					.map((c) =>
						serializeSimplifiedNode(c, 0, false, false, {
							omitHrefs,
							preserveFullHrefs,
						}),
					)
					.join("\n");
			} else if (typeof finalHoistedTree === "string") {
				yaml = finalHoistedTree;
			}
			return yaml;
		},
	);
	let postProcessedYaml = yaml;
	postProcessedYaml = timeSimplifyDomPhaseSync(
		{
			stepNumber,
			phase: "pruneLargeHiddenHierarchies",
			detail: () => `html_chars=${postProcessedYaml.length}`,
		},
		() => {
			postProcessedYaml = pruneLargeHiddenHierarchies(
				yaml,
				undefined,
				true,
			);
			return postProcessedYaml;
		},
	);

	const serializedDom = postProcessedYaml;

	if (serializedDom.trim().length === 0) {
		return await buildNonHtmlFallbackSnapshot(b);
	}

	// Stamp data-bid on the live DOM using backendNodeIds
	await timeSimplifyDomPhase(
		{
			stepNumber,
			phase: "stampDataBidsOnLiveDom",
			detail: () => `bid_stamps=${bidStamps.length}`,
		},
		async () => await stampDataBidsOnLiveDom(b, bidStamps),
	);
	if (includeNonClickableIds) {
		await timeSimplifyDomPhase(
			{
				stepNumber,
				phase: "stampDataNonClickableIdsOnLiveDom",
				detail: () =>
					`nonclickable_stamps=${nonClickableIdStamps.length}`,
			},
			async () =>
				await stampDataNonClickableIdsOnLiveDom(
					b,
					nonClickableIdStamps,
				),
		);
	}

	return serializedDom;
}
