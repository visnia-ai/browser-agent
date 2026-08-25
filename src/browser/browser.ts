import * as chromeLauncher from "chrome-launcher";
import CDP from "chrome-remote-interface";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChildProcess } from "node:child_process";
import type {
	Browser,
	BrowserRemoteInput,
	BrowserViewportMetrics,
} from "./types.js";
import { enableBrowserClientDomains } from "./client-setup.js";
import {
	downloadCurrentFile,
	downloadFileFromUrl,
} from "./download-current-pdf.js";
import { withLocalCdpHost } from "./local-cdp.js";
import { installPrintInterception } from "./print-interception.js";
import {
	downsampleScreenshotByFactor,
	getWindowDevicePixelRatio,
} from "./interaction/capture-screenshot-with-bid-borders.js";
import {
	resolveElement,
	splitRefCandidates,
	sleep,
} from "./interaction/utils.js";

export { click } from "./interaction/click.js";
export { longPress } from "./interaction/long-press.js";
export { scroll } from "./interaction/scroll.js";
export { type } from "./interaction/type.js";
export { pasteFile } from "./interaction/paste-file.js";
export {
	clickWithFileChooserGuard,
	uploadFiles,
} from "./interaction/upload.js";
export type { UploadFilesResult } from "./interaction/upload.js";
export {
	assertPasswordInputRef,
	ensureCheckboxChecked,
	readIdentifierInputByRef,
} from "./interaction/auth.js";

export const NAVIGATE_LOAD_EVENT_TIMEOUT_MS = 30_000;
export {
	captureScreenshotWithBidBorders,
	downsampleScreenshotByFactor,
	getWindowDevicePixelRatio,
} from "./interaction/capture-screenshot-with-bid-borders.js";
export { listTabs, newTab, switchTab, closeTab } from "./interaction/tabs.js";
export { waitForAllOpenTabsToSettle } from "./interaction/wait-for-open-tabs-settle.js";
export { screenshotElementInIsolatedPage } from "./interaction/screenshot-element-isolated.js";
export {
	pruneLiveDomByBids,
	pruneLiveDomByIdentifiers,
	unpruneLiveDom,
} from "./interaction/prune-live-dom.js";
export { sleep } from "./interaction/utils.js";

const KEYCHAIN_BYPASS_FLAGS = new Set([
	"--password-store=basic",
	"--use-mock-keychain",
]);

const PAGE_LOAD_NAVIGATION_PROTOCOLS = new Set([
	"http:",
	"https:",
	"file:",
	"data:",
	"about:",
]);
const CDP_CONNECT_RETRY_COUNT = 20;
const CDP_CONNECT_RETRY_DELAY_MS = 250;

function isCdpConnectionRefusedError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}
	const candidate = error as { code?: unknown; message?: unknown };
	if (candidate.code === "ECONNREFUSED") {
		return true;
	}
	return typeof candidate.message === "string"
		? candidate.message.includes("ECONNREFUSED")
		: false;
}

async function connectToBrowserWithRetry(port: number): Promise<CDP.Client> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= CDP_CONNECT_RETRY_COUNT; attempt += 1) {
		try {
			return await CDP({ host: "127.0.0.1", port });
		} catch (error) {
			lastError = error;
			if (
				!isCdpConnectionRefusedError(error) ||
				attempt === CDP_CONNECT_RETRY_COUNT
			) {
				throw error;
			}
			await sleep(CDP_CONNECT_RETRY_DELAY_MS);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function shouldAwaitPageLoadAfterNavigate(input: {
	url: string;
	isDownload?: boolean;
}): boolean {
	if (input.isDownload) {
		return false;
	}

	try {
		const protocol = new URL(input.url, "http://localhost").protocol;
		return PAGE_LOAD_NAVIGATION_PROTOCOLS.has(protocol);
	} catch {
		return true;
	}
}

export function isSupportedInBrowserNavigateUrl(url: string): boolean {
	try {
		const protocol = new URL(url, "http://localhost").protocol;
		return PAGE_LOAD_NAVIGATION_PROTOCOLS.has(protocol);
	} catch {
		return false;
	}
}

export async function configureDownloadBehavior(
	client: Pick<CDP.Client, "send">,
	downloadDir: string,
): Promise<string> {
	const resolvedDownloadDir = path.resolve(downloadDir);
	fs.mkdirSync(resolvedDownloadDir, { recursive: true });
	try {
		await client.send("Browser.setDownloadBehavior", {
			behavior: "allow",
			downloadPath: resolvedDownloadDir,
			eventsEnabled: true,
		});
		return resolvedDownloadDir;
	} catch (browserError) {
		try {
			await client.send("Page.setDownloadBehavior", {
				behavior: "allow",
				downloadPath: resolvedDownloadDir,
			});
			return resolvedDownloadDir;
		} catch (pageError) {
			const browserMessage =
				browserError instanceof Error
					? browserError.message
					: String(browserError);
			const pageMessage =
				pageError instanceof Error
					? pageError.message
					: String(pageError);
			throw new Error(
				`Failed to configure automatic downloads for ${resolvedDownloadDir}. Browser.setDownloadBehavior: ${browserMessage}. Page.setDownloadBehavior: ${pageMessage}.`,
			);
		}
	}
}

export function configurePdfDownloadPreference(userDataDir: string): void {
	const profileDir = path.join(userDataDir, "Default");
	const preferencesPath = path.join(profileDir, "Preferences");
	let preferences: Record<string, unknown> = {};
	if (fs.existsSync(preferencesPath)) {
		const parsed = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Invalid Chrome preferences: ${preferencesPath}`);
		}
		preferences = parsed as Record<string, unknown>;
	}
	const plugins =
		preferences.plugins &&
		typeof preferences.plugins === "object" &&
		!Array.isArray(preferences.plugins)
			? (preferences.plugins as Record<string, unknown>)
			: {};
	preferences.plugins = {
		...plugins,
		always_open_pdf_externally: true,
	};

	fs.mkdirSync(profileDir, { recursive: true });
	const temporarySuffix = crypto.randomBytes(4).toString("hex");
	const temporaryPath =
		`${preferencesPath}.browser-agent-${process.pid}-${temporarySuffix}`;
	fs.writeFileSync(temporaryPath, JSON.stringify(preferences), "utf8");
	fs.renameSync(temporaryPath, preferencesPath);
}

export function buildChromeLaunchFlags(input: {
	headless: boolean;
	proxy?: { host: string; port: number };
	userDataDirOverride?: string;
}): string[] {
	const preserveProfileSecrets = Boolean(input.userDataDirOverride);
	const isRootUser =
		typeof process.getuid === "function" && process.getuid() === 0;
	const defaultFlags = chromeLauncher.Launcher.defaultFlags().filter(
		(flag) =>
			flag !== "--disable-setuid-sandbox" &&
			(!preserveProfileSecrets || !KEYCHAIN_BYPASS_FLAGS.has(flag)),
	);
	const chromeFlags = [
		...defaultFlags,
		"--window-size=1280,900",
		"--disable-features=TranslateUI",
	];
	if (input.headless) {
		chromeFlags.push("--headless=new");
	}
	if (input.proxy) {
		chromeFlags.push(
			`--proxy-server=${input.proxy.host}:${input.proxy.port}`,
		);
	}
	if (isRootUser) {
		chromeFlags.push("--no-sandbox");
	}
	return chromeFlags;
}

export class ChromeExecutableNotFoundError extends Error {
	constructor(message = "Chrome executable was not found.") {
		super(message);
		this.name = "ChromeExecutableNotFoundError";
	}
}

export function resolveChromeExecutablePath(executablePath?: string): string {
	if (executablePath) {
		const resolved = path.resolve(executablePath);
		if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
			throw new ChromeExecutableNotFoundError(
				"Configured Chrome executable was not found.",
			);
		}
		return resolved;
	}
	try {
		const detected = chromeLauncher.getChromePath();
		if (detected) return detected;
	} catch {
		// Normalize chrome-launcher's platform-specific lookup errors.
	}
	throw new ChromeExecutableNotFoundError();
}

export async function launch(
	debuggingPort?: number,
	headless = false,
	proxy?: { host: string; port: number },
	downloadDirOverride?: string,
	userDataDirOverride?: string,
	windowMode: "visible" | "hidden" = "visible",
	executablePath?: string,
): Promise<Browser> {
	const sessionId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
	const userDataDir = userDataDirOverride
		? path.resolve(userDataDirOverride)
		: path.join(
				os.tmpdir(),
				"browser-agent",
				"chrome-user-data",
				debuggingPort !== undefined
					? `port-${debuggingPort}`
					: `session-${sessionId}`,
			);
	fs.mkdirSync(userDataDir, { recursive: true });
	configurePdfDownloadPreference(userDataDir);

	const chromeFlags = buildChromeLaunchFlags({
		headless,
		proxy,
		userDataDirOverride,
	});

	const chrome = await chromeLauncher.launch({
		ignoreDefaultFlags: true,
		chromeFlags,
		userDataDir,
		...(executablePath ? { chromePath: executablePath } : {}),
		...(debuggingPort ? { port: debuggingPort } : {}),
	});
	const downloadDir = downloadDirOverride
		? path.resolve(downloadDirOverride)
		: path.join(
				os.tmpdir(),
				"browser-agent",
				"downloads",
				`port-${chrome.port}`,
				`session-${sessionId}`,
			);
	fs.mkdirSync(downloadDir, { recursive: true });

	const client = await connectToBrowserWithRetry(chrome.port);
	const { Page, Runtime, DOM, DOMSnapshot, Input, Target, Accessibility } =
		await enableBrowserClientDomains(client);
	if (!headless && windowMode === "hidden") {
		await hideWindow({
			client,
			port: chrome.port,
		});
	}

	await configureDownloadBehavior(client, downloadDir);
	const browserForHooks = {
		client,
		chrome,
		Page,
		Runtime,
		DOM,
		DOMSnapshot,
		Input,
		Target,
		Accessibility,
		currentTargetId: undefined,
		port: chrome.port,
		downloadDir,
		userDataDir,
	};
	await installPrintInterception(browserForHooks);

	return {
		client,
		chrome,
		Page,
		Runtime,
		DOM,
		DOMSnapshot,
		Input,
		Target,
		Accessibility,
		currentTargetId: undefined,
		port: chrome.port,
		downloadDir,
		userDataDir,
	};
}

export async function connectToTarget(input: {
	port: number;
	targetId: string;
	downloadDir?: string;
	userDataDir?: string;
	closeTransport?: () => Promise<void>;
	onActivateTarget?: (targetId: string) => Promise<void>;
}): Promise<Browser> {
	const client = await CDP(
		withLocalCdpHost({
			port: input.port,
			target: input.targetId,
		}),
	);
	const domains = await enableBrowserClientDomains(client);
	const downloadDir = input.downloadDir
		? await configureDownloadBehavior(client, input.downloadDir)
		: undefined;
	const browser = {
		client,
		chrome: {
			port: input.port,
			pid: process.pid,
			process: undefined,
			kill: async () => undefined,
		} as unknown as chromeLauncher.LaunchedChrome,
		...domains,
		currentTargetId: input.targetId,
		port: input.port,
		downloadDir,
		userDataDir: input.userDataDir,
		closeTransport: input.closeTransport,
		onActivateTarget: input.onActivateTarget,
	};
	await installPrintInterception(browser);

	return browser;
}

async function getChromeWindowId(input: {
	client: CDP.Client;
}): Promise<number | null> {
	try {
		const response = (await input.client.send(
			"Browser.getWindowForTarget",
			{},
		)) as {
			windowId?: number;
		};
		return typeof response.windowId === "number" ? response.windowId : null;
	} catch {
		return null;
	}
}

async function setWindowBounds(
	input: {
		client: CDP.Client;
	},
	bounds: Record<string, unknown>,
): Promise<void> {
	const windowId = await getChromeWindowId(input);
	if (!windowId) {
		return;
	}

	try {
		await input.client.send("Browser.setWindowBounds", {
			windowId,
			bounds,
		});
	} catch {
		// Some environments do not expose window controls. Best effort only.
	}
}

export async function hideWindow(
	b: Pick<Browser, "client" | "port">,
): Promise<void> {
	await setWindowBounds(
		{
			client: b.client,
		},
		{
			left: -20_000,
			top: 0,
			width: 1280,
			height: 900,
			windowState: "normal",
		},
	);
}

export async function showWindow(
	b: Pick<Browser, "client" | "port">,
): Promise<void> {
	await setWindowBounds(
		{
			client: b.client,
		},
		{
			left: 120,
			top: 120,
			width: 1280,
			height: 900,
			windowState: "normal",
		},
	);
}

function parseJpegDimensions(
	base64Data: string,
): { width: number; height: number } | null {
	let bytes: Buffer;
	try {
		bytes = Buffer.from(base64Data, "base64");
	} catch {
		return null;
	}
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		return null;
	}

	let offset = 2;
	while (offset + 1 < bytes.length) {
		while (offset < bytes.length && bytes[offset] !== 0xff) {
			offset += 1;
		}
		if (offset + 1 >= bytes.length) {
			break;
		}

		const marker = bytes[offset + 1];
		offset += 2;

		if (
			marker === 0xd8 ||
			marker === 0x01 ||
			(marker >= 0xd0 && marker <= 0xd9)
		) {
			continue;
		}

		if (offset + 1 >= bytes.length) {
			break;
		}
		const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
		if (segmentLength < 2 || offset + segmentLength > bytes.length) {
			break;
		}

		const isStartOfFrame =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc;
		if (isStartOfFrame) {
			if (offset + 6 >= bytes.length) {
				break;
			}
			const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
			const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
			if (width > 0 && height > 0) {
				return { width, height };
			}
			break;
		}

		offset += segmentLength;
	}

	return null;
}

async function buildViewportClip(b: Pick<Browser, "Page">): Promise<{
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
}> {
	const metrics = await b.Page.getLayoutMetrics();
	const viewport = metrics.cssVisualViewport;

	return {
		x: viewport.pageX,
		y: viewport.pageY,
		width: Math.max(1, Math.floor(viewport.clientWidth)),
		height: Math.max(1, Math.floor(viewport.clientHeight)),
		scale: 1,
	};
}

export async function capturePreviewDataUrl(
	b: Pick<Browser, "Page" | "Runtime">,
): Promise<string> {
	const viewportClip = await buildViewportClip(b);
	const format = "webp" as const;
	const quality = 30;
	const capturedScreenshot = await b.Page.captureScreenshot({
		format,
		quality,
		captureBeyondViewport: false,
		fromSurface: true,
		clip: viewportClip,
	});

	if (!capturedScreenshot.data) {
		throw new Error("Chrome preview capture returned empty image data.");
	}

	const devicePixelRatio = await getWindowDevicePixelRatio(b.Runtime);
	const base64 = await downsampleScreenshotByFactor({
		base64Image: capturedScreenshot.data,
		format,
		quality,
		devicePixelRatio,
	});

	return `data:image/webp;base64,${base64}`;
}

export async function getViewportMetrics(
	b: Pick<Browser, "Runtime">,
): Promise<BrowserViewportMetrics> {
	const { result } = await b.Runtime.evaluate({
		expression: `(() => ({
			width: Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0),
			height: Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0),
			deviceScaleFactor: window.devicePixelRatio || 1,
		}))()`,
		returnByValue: true,
	});
	const value = result.value as Partial<BrowserViewportMetrics> | undefined;
	return {
		width: typeof value?.width === "number" ? value.width : 1280,
		height: typeof value?.height === "number" ? value.height : 900,
		deviceScaleFactor:
			typeof value?.deviceScaleFactor === "number"
				? value.deviceScaleFactor
				: 1,
	};
}

function keyDefinitionForInput(key: string) {
	switch (key) {
		case "Enter":
			return {
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				nativeVirtualKeyCode: 13,
				text: "\r",
				unmodifiedText: "\r",
			};
		case "Escape":
			return {
				key: "Escape",
				code: "Escape",
				windowsVirtualKeyCode: 27,
				nativeVirtualKeyCode: 27,
			};
		case "Backspace":
			return {
				key: "Backspace",
				code: "Backspace",
				windowsVirtualKeyCode: 8,
				nativeVirtualKeyCode: 8,
			};
		case "Tab":
			return {
				key: "Tab",
				code: "Tab",
				windowsVirtualKeyCode: 9,
				nativeVirtualKeyCode: 9,
				text: "\t",
				unmodifiedText: "\t",
			};
		case "ArrowLeft":
		case "ArrowRight":
		case "ArrowUp":
		case "ArrowDown":
			return {
				key,
				code: key,
				windowsVirtualKeyCode:
					key === "ArrowLeft"
						? 37
						: key === "ArrowUp"
							? 38
							: key === "ArrowRight"
								? 39
								: 40,
				nativeVirtualKeyCode:
					key === "ArrowLeft"
						? 37
						: key === "ArrowUp"
							? 38
							: key === "ArrowRight"
								? 39
								: 40,
			};
		default:
			return {
				key,
				code: key,
			};
	}
}

export async function dispatchRemoteInput(
	b: Pick<Browser, "Input" | "Page">,
	input: BrowserRemoteInput,
): Promise<void> {
	switch (input.kind) {
		case "mouse":
			await b.Input.dispatchMouseEvent({
				type:
					input.event === "move"
						? "mouseMoved"
						: input.event === "down"
							? "mousePressed"
							: "mouseReleased",
				x: input.x,
				y: input.y,
				button: input.button ?? "left",
				clickCount: input.clickCount ?? 1,
			});
			return;
		case "wheel":
			await b.Input.dispatchMouseEvent({
				type: "mouseWheel",
				x: input.x,
				y: input.y,
				deltaX: input.deltaX,
				deltaY: input.deltaY,
			});
			return;
		case "text":
			await b.Input.insertText({ text: input.text });
			return;
		case "key": {
			const definition = keyDefinitionForInput(input.key);
			await b.Input.dispatchKeyEvent({
				type: "keyDown",
				...definition,
			});
			await b.Input.dispatchKeyEvent({
				type: "keyUp",
				...definition,
			});
			return;
		}
		case "history": {
			const { currentIndex, entries } =
				await b.Page.getNavigationHistory();
			const nextEntry =
				input.direction === "back"
					? entries[currentIndex - 1]
					: entries[currentIndex + 1];
			if (!nextEntry) {
				return;
			}
			await b.Page.navigateToHistoryEntry({
				entryId: nextEntry.id,
			});
			return;
		}
		case "reload":
			await b.Page.reload();
			await b.Page.loadEventFired();
			return;
	}
}

export async function navigate(b: Browser, url: string): Promise<void> {
	const result = await b.Page.navigate({ url });
	const isDownload = (result as { isDownload?: boolean }).isDownload;
	if (shouldAwaitPageLoadAfterNavigate({ url, isDownload })) {
		await Promise.race([
			b.Page.loadEventFired(),
			new Promise<"timeout">((resolve) =>
				setTimeout(
					() => resolve("timeout"),
					NAVIGATE_LOAD_EVENT_TIMEOUT_MS,
				),
			),
		]).then(async (loadResult) => {
			if (loadResult !== "timeout") return;
			console.warn(
				`[browser] navigate loadEventFired timeout after ${NAVIGATE_LOAD_EVENT_TIMEOUT_MS}ms for ${url}; continuing`,
			);
			try {
				const { result: readyStateResult } = await b.Runtime.evaluate({
					expression: "document.readyState",
					returnByValue: true,
				});
				const readyState =
					typeof readyStateResult.value === "string"
						? readyStateResult.value
						: "unknown";
				console.warn(
					`[browser] navigate readyState after timeout: ${readyState}`,
				);
			} catch {
				// Ignore best-effort readyState probe failures.
			}
		});
	}
	await sleep(1500); // let JS settle
}

export { downloadCurrentFile, downloadFileFromUrl };
export {
	consumePrintRequestsAndSavePdfs,
	installPrintInterception,
} from "./print-interception.js";

export async function getRawMainDocumentHTML(b: Browser): Promise<string> {
	const { frameTree } = await b.Page.getResourceTree();
	const frameId = frameTree.frame.id;
	const url = frameTree.frame.url;

	try {
		const { content, base64Encoded } = await b.Page.getResourceContent({
			frameId,
			url,
		});

		return base64Encoded
			? Buffer.from(content, "base64").toString("utf-8")
			: content;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("Content unavailable")) {
			throw error;
		}
		return await getHTML(b);
	}
}

export async function getHTML(b: Browser): Promise<string> {
	const { result } = await b.Runtime.evaluate({
		expression: "document.documentElement.outerHTML",
		returnByValue: true,
	});
	return result.value as string;
}

export async function getURL(b: Browser): Promise<string> {
	const { frameTree } = await b.Page.getFrameTree();
	return frameTree.frame.url;
}

export async function getLocale(b: Browser): Promise<string> {
	const { result } = await b.Runtime.evaluate({
		expression: "navigator.language || navigator.userLanguage || 'en'",
		returnByValue: true,
	});
	return result.value as string;
}

export async function execJS(b: Browser, js: string): Promise<string> {
	try {
		const { result, exceptionDetails } = await b.Runtime.evaluate({
			expression: js,
			returnByValue: true,
			awaitPromise: true,
		});
		if (exceptionDetails) return `ERROR: ${exceptionDetails.text}`;
		return String(result.value ?? "");
	} catch (err) {
		return `ERROR: ${(err as Error).message}`;
	}
}

/**
 * Selects a native option by its value or visible label through a semantic ref.
 */
export async function dropdownSelect(
	b: Browser,
	ref: string,
	value: string,
): Promise<void> {
	const candidates = splitRefCandidates(ref);
	const attemptErrors: string[] = [];

	for (const candidateRef of candidates) {
		try {
			const { objectId } = await resolveElement(b, candidateRef);
			const { result } = await b.Runtime.callFunctionOn({
				objectId,
				functionDeclaration: `function(want) {
					if (!(this instanceof HTMLSelectElement)) return "not a native select";
					const option = Array.from(this.options).find(
						(candidate) => candidate.value === want || candidate.text.trim() === want,
					);
					if (!option) return "no option with matching value or label";
					this.value = option.value;
					this.dispatchEvent(new Event("input", { bubbles: true }));
					this.dispatchEvent(new Event("change", { bubbles: true }));
					return "";
				}`,
				arguments: [{ value }],
				returnByValue: true,
			});
			const error = typeof result.value === "string" ? result.value : "";
			if (error) {
				attemptErrors.push(`${candidateRef}: ${error}`);
				continue;
			}
			return;
		} catch (error) {
			attemptErrors.push(
				`${candidateRef}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	throw new Error(
		`Failed dropdown_select ref=${ref} value=${JSON.stringify(value)}: ${summary}`,
	);
}

interface ParentBidCandidate {
	bid: string;
	containsCount: number;
	depth: number;
	inputOrder: number;
}

export function pickMostParentBid(
	candidates: ParentBidCandidate[],
): string | null {
	if (candidates.length === 0) return null;
	const sorted = [...candidates].sort((a, b) => {
		if (a.containsCount !== b.containsCount) {
			return b.containsCount - a.containsCount;
		}
		if (a.depth !== b.depth) {
			return a.depth - b.depth;
		}
		return a.inputOrder - b.inputOrder;
	});
	return sorted[0].bid;
}

export async function findMostParentBid(
	b: Browser,
	bids: string[],
): Promise<string | null> {
	const normalizedBids: string[] = [];
	const seen = new Set<string>();
	for (const rawBid of bids) {
		for (const bid of splitRefCandidates(rawBid)) {
			if (seen.has(bid)) continue;
			seen.add(bid);
			normalizedBids.push(bid);
		}
	}
	if (normalizedBids.length === 0) return null;

	const { result } = await b.Runtime.evaluate({
		expression: `(() => {
      const requested = ${JSON.stringify(normalizedBids)};
      const all = Array.from(document.querySelectorAll("[data-bid]"));
      const byBid = new Map();
      for (const el of all) {
        const bid = el.getAttribute("data-bid");
        if (!bid || byBid.has(bid)) continue;
        byBid.set(bid, el);
      }

      const existing = [];
      for (let i = 0; i < requested.length; i++) {
        const bid = requested[i];
        const el = byBid.get(bid);
        if (!el) continue;
        let depth = 0;
        let cursor = el.parentElement;
        while (cursor) {
          depth++;
          cursor = cursor.parentElement;
        }
        existing.push({ bid, el, inputOrder: i, depth });
      }

      const candidates = existing.map((current) => ({
        bid: current.bid,
        inputOrder: current.inputOrder,
        depth: current.depth,
        containsCount: existing.reduce((count, other) => {
          if (current.el === other.el) return count;
          return current.el.contains(other.el) ? count + 1 : count;
        }, 0),
      }));

      return candidates;
    })()`,
		returnByValue: true,
	});

	const candidates = Array.isArray(result.value)
		? (result.value as ParentBidCandidate[])
		: [];
	return pickMostParentBid(candidates);
}

export async function findTopParentBids(
	b: Browser,
	bids: string[],
): Promise<string[]> {
	const normalizedBids: string[] = [];
	const seen = new Set<string>();
	for (const rawBid of bids) {
		for (const bid of splitRefCandidates(rawBid)) {
			if (seen.has(bid)) continue;
			seen.add(bid);
			normalizedBids.push(bid);
		}
	}
	if (normalizedBids.length === 0) return [];

	const { result } = await b.Runtime.evaluate({
		expression: `(() => {
      const requested = ${JSON.stringify(normalizedBids)};
      const all = Array.from(document.querySelectorAll("[data-bid]"));
      const byBid = new Map();
      for (const el of all) {
        const bid = el.getAttribute("data-bid");
        if (!bid || byBid.has(bid)) continue;
        byBid.set(bid, el);
      }

      const entries = requested.map((bid, index) => ({
        bid,
        index,
        el: byBid.get(bid) || null,
      }));
      const existing = entries.filter((entry) => entry.el);
      const topLevel = new Set(
        existing
          .filter(
            (entry) =>
              !existing.some(
                (other) => other !== entry && other.el.contains(entry.el),
              ),
          )
          .map((entry) => entry.bid),
      );

      return entries
        .filter((entry) => !entry.el || topLevel.has(entry.bid))
        .map((entry) => entry.bid);
    })()`,
		returnByValue: true,
	});

	return Array.isArray(result.value)
		? (result.value as string[])
		: normalizedBids;
}

export async function findScreenshotCaptureBids(
	b: Browser,
	bids: string[],
	maxParentWidth = 500,
	maxParentHeight = 500,
): Promise<string[]> {
	const normalizedBids: string[] = [];
	const seen = new Set<string>();
	for (const rawBid of bids) {
		for (const bid of splitRefCandidates(rawBid)) {
			if (seen.has(bid)) continue;
			seen.add(bid);
			normalizedBids.push(bid);
		}
	}
	if (normalizedBids.length === 0) return [];

	const { result } = await b.Runtime.evaluate({
		expression: `(() => {
      const requested = ${JSON.stringify(normalizedBids)};
      const maxParentWidth = ${JSON.stringify(maxParentWidth)};
      const maxParentHeight = ${JSON.stringify(maxParentHeight)};

      const all = Array.from(document.querySelectorAll("[data-bid]"));
      const byBid = new Map();
      for (const el of all) {
        const bid = el.getAttribute("data-bid");
        if (!bid || byBid.has(bid)) continue;
        byBid.set(bid, el);
      }

      const pickTopLevel = (orderedBids) => {
        const entries = orderedBids.map((bid, index) => ({
          bid,
          index,
          el: byBid.get(bid) || null,
        }));
        const existing = entries.filter((entry) => entry.el);
        const topLevel = new Set(
          existing
            .filter(
              (entry) =>
                !existing.some(
                  (other) => other !== entry && other.el.contains(entry.el),
                ),
            )
            .map((entry) => entry.bid),
        );
        return entries
          .filter((entry) => !entry.el || topLevel.has(entry.bid))
          .map((entry) => entry.bid);
      };

      const topLevelRequested = pickTopLevel(requested);

      const promoted = [];
      for (const bid of topLevelRequested) {
        const el = byBid.get(bid);
        if (!el) {
          promoted.push(bid);
          continue;
        }

        let chosenBid = bid;
        let cursor = el;
        while (cursor.parentElement) {
          const parent = cursor.parentElement;
          const rect = parent.getBoundingClientRect();
          if (
            rect.width > maxParentWidth ||
            rect.height > maxParentHeight
          ) {
            break;
          }

          const parentBid = parent.getAttribute("data-bid");
          if (parentBid && byBid.get(parentBid) === parent) {
            chosenBid = parentBid;
          }
          cursor = parent;
        }

        promoted.push(chosenBid);
      }

      const dedupedPromoted = [];
      const seenPromoted = new Set();
      for (const bid of promoted) {
        if (seenPromoted.has(bid)) continue;
        seenPromoted.add(bid);
        dedupedPromoted.push(bid);
      }

      return pickTopLevel(dedupedPromoted);
    })()`,
		returnByValue: true,
	});

	return Array.isArray(result.value)
		? (result.value as string[])
		: normalizedBids;
}

export async function close(b: Browser): Promise<void> {
	const chromeCloseWaitTimeoutMs = 5_000;
	await b.client.close();
	if (b.closeTransport) {
		await b.closeTransport();
		return;
	}
	const chromeProcess = (
		b.chrome as chromeLauncher.LaunchedChrome & {
			chromeProcess?: ChildProcess;
		}
	).chromeProcess;
	if (!chromeProcess || chromeProcess.exitCode !== null) {
		await b.chrome.kill();
		return;
	}
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let timeout: NodeJS.Timeout | null = setTimeout(() => {
			timeout = null;
			finish();
		}, chromeCloseWaitTimeoutMs);
		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
				timeout = null;
			}
			chromeProcess.removeListener("close", finish);
			resolve();
		};
		chromeProcess.once("close", finish);
		try {
			b.chrome.kill();
			if (chromeProcess.exitCode !== null) {
				finish();
			}
		} catch (error) {
			chromeProcess.removeListener("close", finish);
			settled = true;
			reject(error);
		}
	});
}
