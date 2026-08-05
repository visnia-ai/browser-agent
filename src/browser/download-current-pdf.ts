import * as fs from "fs";
import * as path from "path";
import type { Browser } from "./types.js";

interface RuntimeFileInspection {
	contentType?: string;
	title?: string;
	urlCandidates?: unknown;
	viewerTags?: unknown;
}

interface DownloadedFileData {
	buffer: Buffer;
	fileName?: string;
	sourceUrl?: string;
	contentType?: string;
}

const CANDIDATE_PARAM_KEYS = ["src", "url", "file"];
const DOWNLOADABLE_EXTENSION_SET = new Set([
	"pdf",
	"csv",
	"json",
	"xml",
	"txt",
	"yaml",
	"yml",
	"jpg",
	"jpeg",
	"png",
	"gif",
	"webp",
	"avif",
	"svg",
	"mp3",
	"wav",
	"ogg",
	"m4a",
	"flac",
	"mp4",
	"mov",
	"webm",
	"avi",
	"zip",
	"gz",
	"tar",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
]);
const NON_HTML_VIEWER_TAG_SET = new Set([
	"embed",
	"object",
	"img",
	"audio",
	"video",
	"source",
	"pre",
]);

function tryDecodeURIComponent(value: string): string {
	let decoded = value.trim();
	for (let index = 0; index < 3; index += 1) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			break;
		}
	}
	return decoded;
}

function looksLikePdfPathname(value: string): boolean {
	return /\.pdf(?:$|[?#])/i.test(value);
}

function extensionFromPathname(value: string): string {
	try {
		const parsed = new URL(value, "https://browser-agent.local");
		const segments = parsed.pathname.split("/").filter(Boolean);
		const last = segments.length > 0 ? segments[segments.length - 1] : "";
		const dot = last.lastIndexOf(".");
		if (dot < 0 || dot === last.length - 1) return "";
		return last.slice(dot + 1).toLowerCase();
	} catch {
		return "";
	}
}

function looksLikeKnownFilePathname(value: string): boolean {
	const extension = extensionFromPathname(value);
	return !!extension && DOWNLOADABLE_EXTENSION_SET.has(extension);
}

function isSupportedDownloadUrl(value: string): boolean {
	return /^(https?:|blob:|data:|file:)/i.test(value);
}

export function extractFileUrlFromViewerUrl(viewerUrl: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(viewerUrl);
	} catch {
		return null;
	}

	if (looksLikeKnownFilePathname(parsed.pathname)) {
		return parsed.href;
	}

	const candidateValues: string[] = [];
	for (const key of CANDIDATE_PARAM_KEYS) {
		const value = parsed.searchParams.get(key);
		if (value) candidateValues.push(value);
	}
	const hash = parsed.hash.startsWith("#")
		? parsed.hash.slice(1)
		: parsed.hash;
	if (hash) {
		const hashParams = new URLSearchParams(hash);
		for (const key of CANDIDATE_PARAM_KEYS) {
			const value = hashParams.get(key);
			if (value) candidateValues.push(value);
		}
	}

	for (const rawValue of candidateValues) {
		const decodedValue = tryDecodeURIComponent(rawValue);
		try {
			const resolved = new URL(decodedValue, parsed.href).toString();
			if (
				isSupportedDownloadUrl(resolved) &&
				(resolved.startsWith("blob:") ||
					resolved.startsWith("data:") ||
					looksLikeKnownFilePathname(resolved))
			) {
				return resolved;
			}
		} catch {
			if (
				isSupportedDownloadUrl(decodedValue) &&
				(decodedValue.startsWith("blob:") ||
					decodedValue.startsWith("data:") ||
					looksLikeKnownFilePathname(decodedValue))
			) {
				return decodedValue;
			}
		}
	}

	return null;
}

export function extractPdfUrlFromViewerUrl(viewerUrl: string): string | null {
	const extracted = extractFileUrlFromViewerUrl(viewerUrl);
	if (!extracted) return null;
	return looksLikePdfPathname(extracted) || extracted.startsWith("blob:")
		? extracted
		: null;
}

function sanitizeFileName(input: string): string {
	const trimmed = input.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-");
	const normalized = trimmed.replace(/\s+/g, " ").replace(/^-+|-+$/g, "");
	return normalized || "download";
}

function ensureExtension(fileName: string, extension: string): string {
	if (!extension) return fileName;
	return fileName.toLowerCase().endsWith(`.${extension}`)
		? fileName
		: `${fileName}.${extension}`;
}

function deriveFileNameFromUrl(fileUrl: string): string | null {
	if (fileUrl.startsWith("blob:") || fileUrl.startsWith("data:")) return null;
	try {
		const parsed = new URL(fileUrl);
		const pathname = parsed.pathname.split("/").filter(Boolean).pop();
		if (!pathname) return null;
		return sanitizeFileName(tryDecodeURIComponent(pathname));
	} catch {
		return null;
	}
}

function normalizeContentType(value: string): string {
	return value.trim().toLowerCase().split(";")[0] || "";
}

function isHtmlContentType(contentType: string): boolean {
	const normalized = normalizeContentType(contentType);
	return normalized === "text/html" || normalized === "application/xhtml+xml";
}

function defaultExtensionForContentType(contentType: string): string {
	const normalized = normalizeContentType(contentType);
	switch (normalized) {
		case "application/pdf":
			return "pdf";
		case "application/json":
			return "json";
		case "text/csv":
			return "csv";
		case "text/plain":
			return "txt";
		case "application/xml":
		case "text/xml":
			return "xml";
		case "image/jpeg":
			return "jpg";
		case "image/png":
			return "png";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		case "image/svg+xml":
			return "svg";
		case "audio/mpeg":
			return "mp3";
		case "audio/wav":
			return "wav";
		case "audio/ogg":
			return "ogg";
		case "video/mp4":
			return "mp4";
		case "video/quicktime":
			return "mov";
		case "video/webm":
			return "webm";
		case "application/zip":
			return "zip";
		default:
			return "";
	}
}

function deriveFileName(params: {
	fileUrl: string;
	contentType?: string;
	title?: string;
	contentDisposition?: string | null;
}): string {
	const extensionFromType = defaultExtensionForContentType(
		params.contentType || "",
	);
	const extensionFromUrl = extensionFromPathname(params.fileUrl);
	const preferredExtension = extensionFromUrl || extensionFromType;
	const disposition = params.contentDisposition ?? "";
	const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
	if (utf8Match?.[1]) {
		return ensureExtension(
			sanitizeFileName(tryDecodeURIComponent(utf8Match[1])),
			preferredExtension,
		);
	}
	const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
	if (plainMatch?.[1]) {
		return ensureExtension(
			sanitizeFileName(plainMatch[1]),
			preferredExtension,
		);
	}

	const fromUrl = deriveFileNameFromUrl(params.fileUrl);
	if (fromUrl) return ensureExtension(fromUrl, preferredExtension);

	const fromTitle =
		typeof params.title === "string" && params.title.trim()
			? sanitizeFileName(params.title)
			: "download";
	return ensureExtension(fromTitle, preferredExtension || "bin");
}

function buildUniqueDownloadPath(
	downloadDir: string,
	fileName: string,
): string {
	const parsed = path.parse(fileName);
	const baseName = parsed.name || "download";
	const extension = parsed.ext || ".bin";
	let candidate = path.join(downloadDir, `${baseName}${extension}`);
	let suffix = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(downloadDir, `${baseName}-${suffix}${extension}`);
		suffix += 1;
	}
	return candidate;
}

async function inspectCurrentFileView(params: {
	browser: Browser;
	currentUrl: string;
}): Promise<{
	contentType: string;
	title: string;
	fileUrl: string | null;
	viewerTags: string[];
}> {
	const { result } = await params.browser.Runtime.evaluate({
		expression: `(() => {
			const candidates = [];
			const seen = new Set();
			const viewerTags = [];
			const push = (value) => {
				if (typeof value !== "string") return;
				const trimmed = value.trim();
				if (!trimmed || seen.has(trimmed)) return;
				seen.add(trimmed);
				candidates.push(trimmed);
			};
			const pushViewerTag = (value) => {
				if (typeof value !== "string") return;
				const lowered = value.toLowerCase();
				if (viewerTags.includes(lowered)) return;
				viewerTags.push(lowered);
			};
			const roots = [];
			const rootSeen = new Set();
			const collectRoot = (root) => {
				if (!root || rootSeen.has(root)) return;
				rootSeen.add(root);
				roots.push(root);
				const elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
				for (const element of elements) {
					if (element.shadowRoot) collectRoot(element.shadowRoot);
				}
			};

			collectRoot(document);
			push(location.href);
			push(document.URL);
			push(document.baseURI);

			for (const root of roots) {
				const elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
				for (const element of elements) {
					pushViewerTag(element.tagName || "");
					push(element.getAttribute?.("src"));
					push(element.getAttribute?.("data"));
					push(element.getAttribute?.("href"));
					push(element.getAttribute?.("original-url"));
					push(element.getAttribute?.("stream-url"));
					push(element.currentSrc);
				}
			}

			return {
				contentType: document.contentType || "",
				title: document.title || "",
				urlCandidates: candidates,
				viewerTags,
			};
		})()`,
		returnByValue: true,
	});

	const pageData =
		result?.value && typeof result.value === "object"
			? (result.value as RuntimeFileInspection)
			: {};
	const contentType =
		typeof pageData.contentType === "string" ? pageData.contentType : "";
	const title = typeof pageData.title === "string" ? pageData.title : "";
	const pageCandidates = Array.isArray(pageData.urlCandidates)
		? pageData.urlCandidates.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
		: [];

	const candidateUrls = [
		params.currentUrl,
		extractFileUrlFromViewerUrl(params.currentUrl),
		...pageCandidates,
	]
		.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		)
		.map((value) => tryDecodeURIComponent(value));

	const viewerTags = Array.isArray(pageData.viewerTags)
		? pageData.viewerTags
				.filter((tag): tag is string => typeof tag === "string")
				.map((tag) => tag.toLowerCase())
				.filter((tag) => NON_HTML_VIEWER_TAG_SET.has(tag))
		: [];

	for (const candidate of candidateUrls) {
		if (candidate.startsWith("blob:") || candidate.startsWith("data:")) {
			return { contentType, title, fileUrl: candidate, viewerTags };
		}
		if (!isSupportedDownloadUrl(candidate)) continue;
		if (looksLikeKnownFilePathname(candidate)) {
			return { contentType, title, fileUrl: candidate, viewerTags };
		}
		const extracted = extractFileUrlFromViewerUrl(candidate);
		if (extracted) {
			return { contentType, title, fileUrl: extracted, viewerTags };
		}
	}

	const currentExtension = extensionFromPathname(params.currentUrl);
	const normalizedType = normalizeContentType(contentType);
	const likelyFileContext =
		(!isHtmlContentType(normalizedType) && normalizedType.length > 0) ||
		!!currentExtension ||
		viewerTags.length > 0;

	if (likelyFileContext && isSupportedDownloadUrl(params.currentUrl)) {
		return {
			contentType,
			title,
			fileUrl: params.currentUrl,
			viewerTags,
		};
	}

	return {
		contentType,
		title,
		fileUrl: null,
		viewerTags,
	};
}

async function getCurrentUrl(browser: Browser): Promise<string> {
	const { frameTree } = await browser.Page.getFrameTree();
	return frameTree.frame.url;
}

async function getCookieHeader(browser: Browser, url: string): Promise<string> {
	try {
		const response = (await browser.client.send("Network.getCookies", {
			urls: [url],
		})) as {
			cookies?: Array<{ name?: string; value?: string }>;
		};
		const pairs = (response.cookies || [])
			.filter(
				(cookie): cookie is { name: string; value: string } =>
					typeof cookie.name === "string" &&
					typeof cookie.value === "string",
			)
			.map((cookie) => `${cookie.name}=${cookie.value}`);
		return pairs.join("; ");
	} catch {
		return "";
	}
}

async function getBrowserUserAgent(browser: Browser): Promise<string> {
	try {
		const { result } = await browser.Runtime.evaluate({
			expression: "navigator.userAgent",
			returnByValue: true,
		});
		return typeof result.value === "string" ? result.value : "";
	} catch {
		return "";
	}
}

async function downloadFileViaFetch(params: {
	browser: Browser;
	fileUrl: string;
	title: string;
	contentType: string;
}): Promise<DownloadedFileData> {
	const headers = new Headers();
	const cookieHeader = await getCookieHeader(params.browser, params.fileUrl);
	if (cookieHeader) headers.set("cookie", cookieHeader);
	const userAgent = await getBrowserUserAgent(params.browser);
	if (userAgent) headers.set("user-agent", userAgent);

	const response = await fetch(params.fileUrl, {
		headers,
		redirect: "follow",
	});
	if (!response.ok) {
		throw new Error(
			`Failed to fetch file (${response.status} ${response.statusText})`,
		);
	}
	const finalUrl = response.url || params.fileUrl;
	const responseContentType =
		response.headers.get("content-type") || params.contentType;

	return {
		buffer: Buffer.from(await response.arrayBuffer()),
		fileName: deriveFileName({
			fileUrl: finalUrl,
			contentType: responseContentType,
			title: params.title,
			contentDisposition: response.headers.get("content-disposition"),
		}),
		sourceUrl: finalUrl,
		contentType: responseContentType,
	};
}

async function downloadFileViaPageFetch(params: {
	browser: Browser;
	fileUrl: string;
	title: string;
	contentType: string;
}): Promise<DownloadedFileData> {
	const { result, exceptionDetails } = await params.browser.Runtime.evaluate({
		expression: `(() => fetch(${JSON.stringify(params.fileUrl)})
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(\`Failed to fetch file (\${response.status} \${response.statusText})\`);
				}
				const arrayBuffer = await response.arrayBuffer();
				const bytes = new Uint8Array(arrayBuffer);
				const chunkSize = 0x8000;
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += chunkSize) {
					binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
				}
				return {
					base64: btoa(binary),
					contentDisposition: response.headers.get("content-disposition"),
					contentType: response.headers.get("content-type"),
					finalUrl: response.url || "",
				};
			}))()`,
		returnByValue: true,
		awaitPromise: true,
	});

	if (exceptionDetails) {
		throw new Error(exceptionDetails.text || "Page-side file fetch failed");
	}

	const value =
		result?.value && typeof result.value === "object"
			? (result.value as {
					base64?: unknown;
					contentDisposition?: unknown;
					contentType?: unknown;
					finalUrl?: unknown;
				})
			: {};
	if (typeof value.base64 !== "string" || !value.base64.trim()) {
		throw new Error("Page-side file fetch returned empty data");
	}
	const contentType =
		typeof value.contentType === "string"
			? value.contentType
			: params.contentType;
	const finalUrl =
		typeof value.finalUrl === "string" && value.finalUrl.trim()
			? value.finalUrl
			: params.fileUrl;

	return {
		buffer: Buffer.from(value.base64, "base64"),
		fileName: deriveFileName({
			fileUrl: finalUrl,
			contentType,
			title: params.title,
			contentDisposition:
				typeof value.contentDisposition === "string"
					? value.contentDisposition
					: null,
		}),
		sourceUrl: finalUrl,
		contentType,
	};
}

export async function downloadCurrentFile(browser: Browser): Promise<string> {
	if (!browser.downloadDir) {
		throw new Error("Browser session has no download directory configured");
	}

	const currentUrl = await getCurrentUrl(browser);
	const fileView = await inspectCurrentFileView({ browser, currentUrl });
	if (!fileView.fileUrl) {
		throw new Error(
			"Current tab does not appear to display a downloadable file",
		);
	}

	const downloaded =
		fileView.fileUrl.startsWith("blob:") ||
		fileView.fileUrl.startsWith("data:")
			? await downloadFileViaPageFetch({
					browser,
					fileUrl: fileView.fileUrl,
					title: fileView.title,
					contentType: fileView.contentType,
				})
			: await downloadFileViaFetch({
					browser,
					fileUrl: fileView.fileUrl,
					title: fileView.title,
					contentType: fileView.contentType,
				});

	fs.mkdirSync(browser.downloadDir, { recursive: true });
	const destinationPath = buildUniqueDownloadPath(
		browser.downloadDir,
		downloaded.fileName ||
			deriveFileName({
				fileUrl: downloaded.sourceUrl || fileView.fileUrl,
				contentType: downloaded.contentType || fileView.contentType,
				title: fileView.title,
			}),
	);
	fs.writeFileSync(destinationPath, downloaded.buffer);
	return destinationPath;
}
