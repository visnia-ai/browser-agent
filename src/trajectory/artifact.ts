import yaml from "js-yaml";
import { stripPayloadForHistory } from "../agents/executor-utils/history-payload.js";
import type { SuccessVerificationResult } from "../agents/types.js";

export interface CompactTrajectoryStep {
	step: number;
	stepKind?: string;
	payload: Record<string, unknown>;
	assistant: Record<string, unknown> | string | null;
	currentURL?: string;
	actions?: unknown;
	done?: boolean;
}

export interface CompactTrajectoryArtifact {
	task: string;
	sourceFile?: string;
	sourceStepCount: number;
	completed: boolean;
	successful: boolean;
	finalResult?: string | null;
	successVerification?: SuccessVerificationResult;
	sourceTargetUrl?: string;
	originalChecklist?: string[];
	finalChecklist?: string[];
	urlSequence: string[];
	steps: CompactTrajectoryStep[];
}

export function buildCompactTrajectoryArtifact(
	entry: unknown,
	options: { sourceFile?: string } = {},
): CompactTrajectoryArtifact {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		throw new Error("trajectory entry must be an object");
	}
	const source = entry as Record<string, unknown>;
	const rawSteps = Array.isArray(source.steps) ? source.steps : [];
	const compactSteps = rawSteps.map((rawStep, index) =>
		buildCompactStep(rawStep, {
			fallbackStep: index + 1,
		}),
	);
	const urlSequence = dedupeConsecutive(
		compactSteps
			.map((step) => step.currentURL)
			.filter((url): url is string => typeof url === "string" && !!url),
	);
	return {
		task: typeof source.task === "string" ? source.task : "",
		sourceFile: options.sourceFile,
		sourceStepCount: rawSteps.length,
		completed: source.completed === true,
		successful: source.successful === true,
		finalResult:
			typeof source.finalResult === "string" || source.finalResult === null
				? source.finalResult
				: undefined,
		successVerification:
			source.successVerification &&
			typeof source.successVerification === "object" &&
			!Array.isArray(source.successVerification)
				? (source.successVerification as SuccessVerificationResult)
				: undefined,
		sourceTargetUrl: extractStageOutputUrl(source, "findTargetURL"),
		originalChecklist: extractOriginalChecklist(source),
		finalChecklist: extractFinalChecklist(rawSteps),
		urlSequence,
		steps: compactSteps,
	};
}

function buildCompactStep(
	rawStep: unknown,
	options: {
		fallbackStep: number;
	},
): CompactTrajectoryStep {
	const source =
		rawStep && typeof rawStep === "object" && !Array.isArray(rawStep)
			? (rawStep as Record<string, unknown>)
			: {};
	const payload = parseStepPromptPayload(source.messages);
	const strippedPayload = payload
		? stripPayloadForHistory({
				payload,
			})
		: {};
	const assistant = parseStepAssistant(source.messages);
	const assistantDone =
		assistant && typeof assistant === "object"
			? (assistant as Record<string, unknown>).done
			: undefined;
	return {
		step:
			typeof source.step === "number" && Number.isFinite(source.step)
				? source.step
				: options.fallbackStep,
		stepKind:
			typeof source.step_kind === "string" ? source.step_kind : undefined,
		payload: strippedPayload,
		assistant,
		currentURL:
			typeof strippedPayload.currentURL === "string"
				? strippedPayload.currentURL
				: undefined,
		actions:
			assistant && typeof assistant === "object"
				? ((assistant as Record<string, unknown>).tools ??
					(assistant as Record<string, unknown>).actions)
				: undefined,
		...(typeof assistantDone === "boolean" ? { done: assistantDone } : {}),
	};
}

function parseStepPromptPayload(
	messages: unknown,
): Record<string, unknown> | null {
	for (const text of userTextContents(messages)) {
		try {
			const parsed = yaml.load(text);
			if (
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				looksLikeStepPromptPayload(parsed as Record<string, unknown>)
			) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			continue;
		}
	}
	return null;
}

function looksLikeStepPromptPayload(payload: Record<string, unknown>): boolean {
	return [
		"task",
		"currentURL",
		"projection",
		"interactionErrors",
		"currentTab",
		"openTabs",
		"downloadedFiles",
		"workspaceFiles",
		"plan",
		"currentPageScreenshotIncludedAsImagePart",
		"latestUserPromptTokenCount",
	].some((key) => key in payload);
}

function parseStepAssistant(
	messages: unknown,
): Record<string, unknown> | string | null {
	if (!Array.isArray(messages)) {
		return null;
	}
	for (const message of [...messages].reverse()) {
		if (
			!message ||
			typeof message !== "object" ||
			(message as { role?: unknown }).role !== "assistant"
		) {
			continue;
		}
		const content = assistantTextContent(
			(message as { content?: unknown }).content,
		);
		if (content === null) continue;
		try {
			const parsed = yaml.load(content);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: content;
		} catch {
			return content;
		}
	}
	return null;
}

function assistantTextContent(content: unknown): string | null {
	if (typeof content === "string") {
		return content.trim() ? content : null;
	}
	if (!Array.isArray(content)) return null;
	const text = content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? [record.text]
				: [];
		})
		.join("");
	return text.trim() ? text : null;
}

function userTextContents(messages: unknown): string[] {
	if (!Array.isArray(messages)) {
		return [];
	}
	const texts: string[] = [];
	for (const message of [...messages].reverse()) {
		if (
			!message ||
			typeof message !== "object" ||
			(message as { role?: unknown }).role !== "user"
		) {
			continue;
		}
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string" && content.trim()) {
			texts.push(content);
			continue;
		}
		if (!Array.isArray(content)) {
			continue;
		}
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string" &&
				(part as { text: string }).text.trim()
			) {
				texts.push((part as { text: string }).text);
			}
		}
	}
	return texts;
}

function extractStageOutputUrl(
	source: Record<string, unknown>,
	stage: string,
): string | undefined {
	const invocations = Array.isArray(source.modelInvocations)
		? source.modelInvocations
		: [];
	const invocation = invocations.find(
		(candidate) =>
			candidate &&
			typeof candidate === "object" &&
			(candidate as { stage?: unknown }).stage === stage,
	);
	if (!invocation || typeof invocation !== "object") {
		return undefined;
	}
	const output = (invocation as { output?: unknown }).output;
	if (!output || typeof output !== "object" || Array.isArray(output)) {
		return undefined;
	}
	const url = (output as { url?: unknown }).url;
	return typeof url === "string" && url.trim() ? url.trim() : undefined;
}

function extractOriginalChecklist(
	source: Record<string, unknown>,
): string[] | undefined {
	const invocations = Array.isArray(source.modelInvocations)
		? source.modelInvocations
		: [];
	const invocation = invocations.find(
		(candidate) =>
			candidate &&
			typeof candidate === "object" &&
			(candidate as { stage?: unknown }).stage === "createChecklist",
	);
	if (!invocation || typeof invocation !== "object") return undefined;
	const output = (invocation as { output?: unknown }).output;
	if (!output || typeof output !== "object" || Array.isArray(output)) {
		return undefined;
	}
	const items = (output as { items?: unknown }).items;
	return Array.isArray(items)
		? items.filter(
				(item): item is string =>
					typeof item === "string" && item.trim().length > 0,
			)
		: undefined;
}

function extractFinalChecklist(rawSteps: unknown[]): string[] | undefined {
	for (let index = rawSteps.length - 1; index >= 0; index--) {
		const source =
			rawSteps[index] &&
			typeof rawSteps[index] === "object" &&
			!Array.isArray(rawSteps[index])
				? (rawSteps[index] as Record<string, unknown>)
				: {};
		const payload = parseStepPromptPayload(source.messages);
		if (!Array.isArray(payload?.checklist)) continue;
		const checklist = payload.checklist.filter(
			(item): item is string => typeof item === "string",
		);
		if (checklist.length > 0) return checklist;
	}
	return undefined;
}

function dedupeConsecutive(values: string[]): string[] {
	const result: string[] = [];
	for (const value of values) {
		if (result[result.length - 1] !== value) {
			result.push(value);
		}
	}
	return result;
}
