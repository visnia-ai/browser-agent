import type { StepHistoryEntry } from "../../core/types.js";

const PROMPT_ONLY_PAYLOAD_FIELDS = [
	"validRefs",
	"interactionErrors",
	"latestUserPromptTokenCount",
	"currentTab",
	"openTabs",
	"newlyOpenedTabs",
	"downloadedFiles",
	"workspaceFiles",
	"autoTabSwitchNote",
	"currentPageScreenshotIncludedAsImagePart",
	"previousAction",
	"task",
	"currentDateTime",
	"memoryAvailable",
	"memoryContent",
	"authContext",
	"checklist",
] as const;

export function stripProjectionContextFromHistoryPayload(
	payload: Record<string, unknown>,
): void {
	delete payload.projection;
	delete payload.projectionContextMode;
}

function stripCommonPromptOnlyFields(payload: Record<string, unknown>): void {
	for (const field of PROMPT_ONLY_PAYLOAD_FIELDS) {
		delete payload[field];
	}
	delete payload.plan;
}

export function stripPayloadForHistory(params: {
	payload: Record<string, unknown>;
	cumulativeProjectionHistoryEnabled?: boolean;
	projectionContextMode?: "reset" | "delta";
	stepsHistory?: StepHistoryEntry[];
}): Record<string, unknown> {
	if (params.cumulativeProjectionHistoryEnabled) {
		if (
			params.projectionContextMode !== "reset" &&
			params.projectionContextMode !== "delta"
		) {
			throw new Error(
				"cumulative semantic projection history requires reset or delta context",
			);
		}
		// Preserve the exact prior user payload. This makes request N an exact
		// prefix of request N+1 and lets provider prefix caching cover history.
		return { ...params.payload };
	}

	const strippedPayload: Record<string, unknown> = { ...params.payload };
	stripCommonPromptOnlyFields(strippedPayload);
	if (!params.cumulativeProjectionHistoryEnabled) {
		stripProjectionContextFromHistoryPayload(strippedPayload);
	}
	return strippedPayload;
}
