import * as fs from "node:fs";
import yaml from "js-yaml";
import type { ExtractedDataResultItem } from "./extract-data-memory.js";

export type MemoryClearTarget = "memory" | "memory_result" | "all";

export function readMemoryFile(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

export function appendMemoryFile(params: {
	filePath: string;
	content: string;
}): void {
	const content = params.content.trim();
	if (!content) return;
	const existing = readMemoryFile(params.filePath).trim();
	fs.writeFileSync(
		params.filePath,
		existing ? `${existing}\n\n${content}` : content,
		"utf-8",
	);
}

function parseMemoryResultItems(content: string): ExtractedDataResultItem[] {
	const trimmed = content.trim();
	if (!trimmed) return [];
	const parsed = yaml.load(trimmed);
	if (!Array.isArray(parsed)) {
		throw new Error("existing memory_result content is not a YAML list");
	}
	const items: ExtractedDataResultItem[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") {
			throw new Error("existing memory_result item is not an object");
		}
		const candidate = entry as { link?: unknown; summary?: unknown };
		if (
			typeof candidate.link !== "string" ||
			typeof candidate.summary !== "string"
		) {
			throw new Error(
				"existing memory_result item must contain string link and summary",
			);
		}
		items.push({
			link: candidate.link,
			summary: candidate.summary,
		});
	}
	return items;
}

export function appendMemoryResultItems(params: {
	filePath: string;
	items: ExtractedDataResultItem[];
}): void {
	if (params.items.length === 0) return;
	const existing = readMemoryFile(params.filePath);
	const mergedItems = [...parseMemoryResultItems(existing), ...params.items];
	fs.writeFileSync(
		params.filePath,
		yaml.dump(mergedItems, { lineWidth: -1 }).trim(),
		"utf-8",
	);
}

let atomicWriteSequence = 0;

export function replaceMemoryResultItems(params: {
	filePath: string;
	items: ExtractedDataResultItem[];
}): void {
	if (params.items.length === 0) {
		throw new Error("cannot replace memory_result with an empty item list");
	}
	const content = yaml.dump(params.items, { lineWidth: -1 }).trim();
	const tempPath = `${params.filePath}.tmp-${process.pid}-${Date.now()}-${++atomicWriteSequence}`;
	try {
		fs.writeFileSync(tempPath, content, "utf-8");
		fs.renameSync(tempPath, params.filePath);
	} finally {
		if (fs.existsSync(tempPath)) {
			fs.unlinkSync(tempPath);
		}
	}
}

export function normalizeMemoryContentForRead(content: string): string {
	return content.trim();
}

export function clearMemoryContent(params: {
	content: string;
	target: MemoryClearTarget;
}): string {
	if (params.target === "all") return "";
	return "";
}

export function clearMemoryFile(params: {
	filePath: string;
	target: MemoryClearTarget;
}): void {
	fs.writeFileSync(
		params.filePath,
		clearMemoryContent({
			content: readMemoryFile(params.filePath),
			target: params.target,
		}),
		"utf-8",
	);
}
