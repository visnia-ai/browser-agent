import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
	getDocument,
	GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker } from "tesseract.js";
import { convertCsvFileToMarkdown } from "./read-file-csv.js";
import {
	convertOfficeFileToMarkdown,
	type OfficeExtension,
} from "./read-file-office.js";
import { resolveLocalFile } from "../../file-workspace.js";

const DEFAULT_MAX_CHARS = 30_000;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const STATUS_PREFIX = /^\[(NEW|DOWNLOADING)\]\s+/;
const IMAGE_EXTENSIONS = new Set([
	".bmp",
	".gif",
	".jpeg",
	".jpg",
	".png",
	".tif",
	".tiff",
	".webp",
]);

export interface ReadFileExtractors {
	extractPdfText(filePath: string, maxChars: number): Promise<string>;
	recognizeImage(filePath: string): Promise<string>;
}

export interface ReadLocalFileInput {
	requestedPath: string;
	downloadedFiles: string[];
	fileWorkspaceRoot?: string;
	downloadDir?: string;
	downloadRootDir?: string;
	maxChars?: number;
	commandTimeoutMs?: number;
	extractors?: ReadFileExtractors;
}

export interface ReadLocalFileResult {
	path: string;
	content: string;
	method:
		| "text"
		| "pdf_text"
		| "image_ocr"
		| "pdf_ocr"
		| "docx_markdown"
		| "xlsx_markdown"
		| "csv_markdown";
	truncated: boolean;
}

function stripStatusPrefix(value: string): {
	path: string;
	downloading: boolean;
} {
	const trimmed = value.trim();
	const match = trimmed.match(STATUS_PREFIX);
	return {
		path: match ? trimmed.slice(match[0].length).trim() : trimmed,
		downloading: match?.[1] === "DOWNLOADING",
	};
}

export function resolveReadableFilePath(
	input: Pick<
		ReadLocalFileInput,
		| "requestedPath"
		| "downloadedFiles"
		| "fileWorkspaceRoot"
		| "downloadDir"
		| "downloadRootDir"
	>,
): { requestedPath: string; resolvedPath: string } {
	const requestedPath = input.requestedPath.trim();
	const downloadEntry = input.downloadedFiles
		.map(stripStatusPrefix)
		.find((entry) => entry.path === requestedPath);
	if (downloadEntry?.downloading) {
		throw new Error(
			`read_file cannot read an in-progress download: ${requestedPath}`,
		);
	}
	try {
		const resolved = resolveLocalFile({
			requestedPath,
			roots: {
				fileWorkspaceRoot: input.fileWorkspaceRoot,
				downloadDir: input.downloadDir,
				downloadRootDir: input.downloadRootDir,
			},
			allowExternalDownload: Boolean(downloadEntry),
		});
		return {
			requestedPath: resolved.logicalPath,
			resolvedPath: resolved.resolvedPath,
		};
	} catch (error) {
		throw new Error(
			`read_file ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

const require = createRequire(import.meta.url);
const standalonePdfWorker = (
	globalThis as typeof globalThis & {
		__browserAgentPdfWorkerPath?: string;
	}
).__browserAgentPdfWorkerPath;
if (standalonePdfWorker) GlobalWorkerOptions.workerSrc = standalonePdfWorker;

interface TesseractRuntimeOptions {
	cachePath?: string;
	gzip: boolean;
	langPath: string;
	workerPath?: string;
}

function tesseractRuntimeOptions(): TesseractRuntimeOptions {
	const standaloneOptions = (
		globalThis as typeof globalThis & {
			__browserAgentTesseractOptions?: TesseractRuntimeOptions;
		}
	).__browserAgentTesseractOptions;
	if (standaloneOptions) return standaloneOptions;
	return require("@tesseract.js-data/eng") as TesseractRuntimeOptions;
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out`)),
					timeoutMs,
				);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function extractPdfTextInProcess(
	filePath: string,
	maxChars: number,
): Promise<string> {
	const document = await getDocument({
		data: new Uint8Array(fs.readFileSync(filePath)),
		useSystemFonts: true,
	}).promise;
	try {
		const pages: string[] = [];
		let length = 0;
		for (
			let pageNumber = 1;
			pageNumber <= document.numPages;
			pageNumber += 1
		) {
			const page = await document.getPage(pageNumber);
			const text = await page.getTextContent();
			const pageText = text.items
				.map((item) => ("str" in item ? item.str : ""))
				.join(" ")
				.trim();
			if (pageText) {
				pages.push(pageText);
				length += pageText.length + 1;
			}
			if (length >= maxChars) break;
		}
		return pages.join("\n");
	} finally {
		await document.destroy();
	}
}

async function recognizeImageInProcess(filePath: string): Promise<string> {
	const options = tesseractRuntimeOptions();
	const worker = await createWorker("eng", 1, {
		...(options.cachePath && { cachePath: options.cachePath }),
		gzip: options.gzip,
		langPath: options.langPath,
		...(options.workerPath && { workerPath: options.workerPath }),
	});
	try {
		const result = await worker.recognize(filePath);
		return result.data.text;
	} finally {
		await worker.terminate();
	}
}

const defaultExtractors: ReadFileExtractors = {
	extractPdfText: extractPdfTextInProcess,
	recognizeImage: recognizeImageInProcess,
};

function readTextPrefix(filePath: string, maxBytes: number): Buffer {
	const descriptor = fs.openSync(filePath, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const bytesRead = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		fs.closeSync(descriptor);
	}
}

function finalizeContent(
	rawContent: string,
	maxChars: number,
	commandTruncated = false,
): { content: string; truncated: boolean } {
	const normalized = rawContent
		.replace(/^\uFEFF/, "")
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.trim();
	if (!normalized) {
		throw new Error("read_file extracted no text");
	}
	const truncated = commandTruncated || normalized.length > maxChars;
	if (!truncated) return { content: normalized, truncated: false };
	const marker = "\n\n[read_file output truncated]";
	return {
		content: `${normalized.slice(0, Math.max(0, maxChars - marker.length))}${marker}`,
		truncated: true,
	};
}

async function extractPdf(params: {
	filePath: string;
	maxChars: number;
	timeoutMs: number;
	extractors: ReadFileExtractors;
}): Promise<{
	content: string;
	method: "pdf_text";
	truncated: boolean;
}> {
	const text = await withTimeout(
		params.extractors.extractPdfText(params.filePath, params.maxChars),
		params.timeoutMs,
		"PDF extraction",
	);
	if (!text.trim()) {
		throw new Error(
			"PDF has no extractable text layer; OCR is currently supported for image files",
		);
	}
	return {
		...finalizeContent(text, params.maxChars),
		method: "pdf_text",
	};
}

export async function readLocalFile(
	input: ReadLocalFileInput,
): Promise<ReadLocalFileResult> {
	const { requestedPath, resolvedPath } = resolveReadableFilePath(input);
	const stats = fs.statSync(resolvedPath);
	if (stats.size > MAX_FILE_BYTES) {
		throw new Error(
			`read_file file exceeds the ${MAX_FILE_BYTES}-byte limit: ${requestedPath}`,
		);
	}
	const maxChars = Math.max(
		1,
		Math.trunc(input.maxChars ?? DEFAULT_MAX_CHARS),
	);
	const timeoutMs = Math.max(
		1,
		Math.trunc(input.commandTimeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS),
	);
	const extension = path.extname(resolvedPath).toLowerCase();
	const extractors = input.extractors ?? defaultExtractors;

	try {
		if (extension === ".docx" || extension === ".xlsx") {
			const markdown = await withTimeout(
				convertOfficeFileToMarkdown(
					resolvedPath,
					extension as OfficeExtension,
				),
				timeoutMs,
				`${extension.slice(1).toUpperCase()} conversion`,
			);
			return {
				path: requestedPath,
				method:
					extension === ".docx" ? "docx_markdown" : "xlsx_markdown",
				...finalizeContent(markdown, maxChars),
			};
		}
		if (extension === ".csv") {
			const markdown = await convertCsvFileToMarkdown(resolvedPath);
			return {
				path: requestedPath,
				method: "csv_markdown",
				...finalizeContent(markdown, maxChars),
			};
		}
		if (extension === ".pdf") {
			const extracted = await extractPdf({
				filePath: resolvedPath,
				maxChars,
				timeoutMs,
				extractors,
			});
			return { path: requestedPath, ...extracted };
		}
		if (IMAGE_EXTENSIONS.has(extension)) {
			const text = await withTimeout(
				extractors.recognizeImage(resolvedPath),
				timeoutMs,
				"image OCR",
			);
			return {
				path: requestedPath,
				method: "image_ocr",
				...finalizeContent(text, maxChars),
			};
		}

		const prefix = readTextPrefix(
			resolvedPath,
			Math.min(MAX_FILE_BYTES, maxChars * 8),
		);
		if (prefix.includes(0)) {
			throw new Error("unsupported binary file type");
		}
		return {
			path: requestedPath,
			method: "text",
			...finalizeContent(
				prefix.toString("utf-8"),
				maxChars,
				stats.size > prefix.length,
			),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`read_file failed for ${requestedPath}: ${message}`);
	}
}
