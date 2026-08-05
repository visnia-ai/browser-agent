import * as crypto from "crypto";
import yaml from "js-yaml";
import type { StepResult } from "../agents/types.js";

export const MAX_STEP_RETRIES = 3;
export const STAGNATION_SAME_ACTION_THRESHOLD = 4;
export const STAGNATION_NO_PROGRESS_THRESHOLD = 5;

export function hashText(value: string): string {
	return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

export function buildActionSignatureWithUrl(
	step: StepResult,
	url: string,
): string {
	const normalizedActions = step.actions.map((action) => {
		const record = action as unknown as Record<string, unknown>;
		const type = typeof record.type === "string" ? record.type : "unknown";
		const ref = typeof record.ref === "string" ? record.ref : "";
		const targetUrl = typeof record.url === "string" ? record.url : "";
		return `${type}:${ref}:${targetUrl}`;
	});
	return `${url}::${yaml.dump(normalizedActions).trim()}`;
}

export function buildProgressSignature(params: {
	url: string;
	projection: string;
	downloadedFiles: string[];
}): string {
	return `${params.url}::${hashText(params.projection)}::${params.downloadedFiles.join("|")}`;
}
