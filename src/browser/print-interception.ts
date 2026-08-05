import * as fs from "fs";
import * as path from "path";
import type { Browser } from "./types.js";

interface PrintRequest {
	url?: string;
	title?: string;
	at?: number;
}

const INSTALL_PRINT_INTERCEPTION_SCRIPT = `
(() => {
	const requestKey = "__baPrintRequests";
	const installKey = "__baPrintInterceptInstalled";
	const w = window;
	if (w[installKey]) return;

	const requests = Array.isArray(w[requestKey]) ? w[requestKey] : [];
	Object.defineProperty(w, requestKey, {
		value: requests,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	Object.defineProperty(w, installKey, {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	Object.defineProperty(w, "print", {
		value: function() {
			requests.push({
				url: String(location.href || ""),
				title: String(document.title || ""),
				at: Date.now(),
			});
			try {
				w.dispatchEvent(new CustomEvent("__ba_print_requested"));
			} catch {
				// Ignore event dispatch failures; the queued request is enough.
			}
		},
		configurable: false,
		enumerable: false,
		writable: false,
	});
})();
`;

function sanitizePrintFileNamePart(input: string): string {
	const trimmed = input.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-");
	const normalized = trimmed.replace(/\s+/g, " ").replace(/^-+|-+$/g, "");
	return normalized || "page";
}

export function buildPrintPdfFileName(params: {
	title?: string;
	url?: string;
	timestampMs: number;
}): string {
	const title = params.title?.trim();
	const fallbackUrl = params.url?.trim();
	const rawName = title || fallbackUrl || "page";
	return `print-${sanitizePrintFileNamePart(rawName)}-${params.timestampMs}.pdf`;
}

function buildUniquePath(downloadDir: string, fileName: string): string {
	const parsed = path.parse(fileName);
	const baseName = parsed.name || "print-page";
	const extension = parsed.ext || ".pdf";
	let candidate = path.join(downloadDir, `${baseName}${extension}`);
	let suffix = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(downloadDir, `${baseName}-${suffix}${extension}`);
		suffix += 1;
	}
	return candidate;
}

function normalizePrintRequests(value: unknown): PrintRequest[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(entry): entry is Record<string, unknown> =>
				Boolean(entry) && typeof entry === "object",
		)
		.map((entry) => ({
			url: typeof entry.url === "string" ? entry.url : undefined,
			title: typeof entry.title === "string" ? entry.title : undefined,
			at: typeof entry.at === "number" ? entry.at : undefined,
		}));
}

export async function installPrintInterception(
	browser: Browser,
): Promise<void> {
	await browser.Page.addScriptToEvaluateOnNewDocument({
		source: INSTALL_PRINT_INTERCEPTION_SCRIPT,
	});
	await browser.Runtime.evaluate({
		expression: INSTALL_PRINT_INTERCEPTION_SCRIPT,
	});
}

export async function consumePrintRequestsAndSavePdfs(
	browser: Browser,
): Promise<string[]> {
	const { result } = await browser.Runtime.evaluate({
		expression: `(() => {
			const requests = Array.isArray(window.__baPrintRequests)
				? window.__baPrintRequests.slice()
				: [];
			if (Array.isArray(window.__baPrintRequests)) {
				window.__baPrintRequests.length = 0;
			}
			return requests;
		})()`,
		returnByValue: true,
	});
	const requests = normalizePrintRequests(result.value);
	if (requests.length === 0) return [];
	if (!browser.downloadDir) {
		throw new Error("Browser session has no download directory configured");
	}

	fs.mkdirSync(browser.downloadDir, { recursive: true });
	const savedPaths: string[] = [];
	for (const [index, request] of requests.entries()) {
		const printed = await browser.Page.printToPDF({
			printBackground: true,
			preferCSSPageSize: true,
		});
		const timestampMs = request.at ?? Date.now() + index;
		const fileName = buildPrintPdfFileName({
			title: request.title,
			url: request.url,
			timestampMs,
		});
		const outputPath = buildUniquePath(browser.downloadDir, fileName);
		fs.writeFileSync(outputPath, Buffer.from(printed.data, "base64"));
		savedPaths.push(outputPath);
	}
	return savedPaths;
}
