import * as path from "path";
import yaml from "js-yaml";
import type { StepResult } from "../types.js";

const DOWNLOADED_FILE_PREFIX_PATTERN = /^\[(?:NEW|DOWNLOADING)\]\s+/;

function stripDownloadedFilePrefix(value: string): string {
	return value.replace(DOWNLOADED_FILE_PREFIX_PATTERN, "").trim();
}

function normalizePathForComparison(value: string): string {
	return value.trim().replaceAll("\\", "/").toLowerCase();
}

function findCanonicalDownloadedFilePath(params: {
	filePath: string;
	downloadedFiles: string[];
}): string | null {
	const normalizedRequestedPath = normalizePathForComparison(params.filePath);
	const canonicalDownloadedFiles = params.downloadedFiles
		.map((entry) => stripDownloadedFilePrefix(entry))
		.filter((entry) => entry.length > 0);

	const exactMatch = canonicalDownloadedFiles.find(
		(entry) =>
			normalizePathForComparison(entry) === normalizedRequestedPath,
	);
	if (exactMatch) {
		return exactMatch;
	}

	const requestedBaseName = path.posix.basename(normalizedRequestedPath);
	if (!requestedBaseName) {
		return null;
	}

	const basenameMatches = canonicalDownloadedFiles.filter(
		(entry) =>
			path.posix.basename(normalizePathForComparison(entry)) ===
			requestedBaseName,
	);
	return basenameMatches.length === 1 ? basenameMatches[0] : null;
}

function rewriteDownloadedFilePaths(
	value: unknown,
	downloadedFiles: string[],
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) =>
			rewriteDownloadedFilePaths(entry, downloadedFiles),
		);
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	const record = value as Record<string, unknown>;
	const rewrittenEntries = Object.entries(record).map(([key, entryValue]) => {
		if (key === "downloaded_file_path" && typeof entryValue === "string") {
			return [
				key,
				findCanonicalDownloadedFilePath({
					filePath: entryValue,
					downloadedFiles,
				}) ?? entryValue,
			];
		}
		return [key, rewriteDownloadedFilePaths(entryValue, downloadedFiles)];
	});

	return Object.fromEntries(rewrittenEntries);
}

export function canonicalizeStepDownloadedFilePaths(params: {
	step: StepResult;
	downloadedFiles: string[];
}): StepResult {
	if (
		typeof params.step.result !== "string" ||
		params.downloadedFiles.length === 0
	) {
		return params.step;
	}

	let parsedResult: unknown;
	try {
		parsedResult = yaml.load(params.step.result);
	} catch {
		return params.step;
	}

	if (!parsedResult || typeof parsedResult !== "object") {
		return params.step;
	}

	const normalizedResult = rewriteDownloadedFilePaths(
		parsedResult,
		params.downloadedFiles,
	);
	const rewrittenResult = yaml.dump(normalizedResult).trim();
	if (rewrittenResult === params.step.result.trim()) {
		return params.step;
	}

	return {
		...params.step,
		result: rewrittenResult,
	};
}
