import yaml from "js-yaml";
import type { LLMOptions, Message } from "../agents/types.js";
import type { buildStepMessages } from "../agents/executor-utils/step-execution.js";
import { stripProjectionContextFromHistoryPayload } from "../agents/executor-utils/history-payload.js";
import { toCompletionPrompt } from "../agents/providers/message-serialization.js";

const PROJECTION_TRUNCATION_MARKER =
	"\n...[projection truncated for context budget]...\n";
const VLLM_PROMPT_BUDGET_SAFETY_MARGIN_TOKENS = 4096;

export interface FitStepPromptToBudgetInput {
	llmOptions?: LLMOptions;
	systemPrompt: string;
	history: Message[];
	payload: Record<string, unknown>;
	buildStepMessages: typeof buildStepMessages;
	estimateTokenCount: (text: string) => number;
	currentPageScreenshotDataUrl?: string;
	projectionHistoryContext?: {
		enabled: boolean;
		canonicalProjection: string;
	};
}

export interface FitStepPromptToBudgetResult {
	messages: Message[];
	payload: Record<string, unknown>;
	currentPageScreenshotDataUrl?: string;
	budgetReport: PromptBudgetReport;
}

export interface PromptBudgetReport {
	maxInputTokens: number | null;
	initialInputTokens: number;
	finalInputTokens: number;
	reductions: string[];
}

export class PromptBudgetExceededError extends Error {
	constructor(input: {
		caller: string;
		estimatedInputTokens: number;
		maxInputTokens: number;
	}) {
		super(
			`${input.caller} prompt exceeds configured input budget ` +
				`(${input.estimatedInputTokens} > ${input.maxInputTokens} tokens)`,
		);
		this.name = "PromptBudgetExceededError";
	}
}

export function resolveMaxInputTokens(llmOptions?: LLMOptions): number | null {
	if (
		typeof llmOptions?.maxModelLen !== "number" ||
		typeof llmOptions.reserveOutputTokens !== "number"
	) {
		return null;
	}
	const safetyMargin =
		llmOptions.provider === "vllm"
			? VLLM_PROMPT_BUDGET_SAFETY_MARGIN_TOKENS
			: 0;
	return Math.max(
		0,
		llmOptions.maxModelLen - llmOptions.reserveOutputTokens - safetyMargin,
	);
}

export function estimateMessagesTokenCount(
	messages: Message[],
	estimateTokenCount: (text: string) => number,
): number {
	return estimateTokenCount(toCompletionPrompt(messages));
}

export function assertPromptFits(input: {
	messages: Message[];
	llmOptions?: LLMOptions;
	estimateTokenCount: (text: string) => number;
	caller: string;
}): number {
	const estimatedInputTokens = estimateMessagesTokenCount(
		input.messages,
		input.estimateTokenCount,
	);
	const maxInputTokens = resolveMaxInputTokens(input.llmOptions);
	if (maxInputTokens !== null && estimatedInputTokens > maxInputTokens) {
		throw new PromptBudgetExceededError({
			caller: input.caller,
			estimatedInputTokens,
			maxInputTokens,
		});
	}
	return estimatedInputTokens;
}

export interface FittingCandidate<T> {
	candidate: T;
	messages: Message[];
	tokenCount: number;
	unitCount: number;
}

export function findLargestFittingCandidate<T>(input: {
	maxUnits: number;
	maxInputTokens: number;
	buildCandidate: (unitCount: number) => T;
	buildMessages: (candidate: T) => Message[];
	estimateTokenCount: (text: string) => number;
}): FittingCandidate<T> | null {
	let low = 0;
	let high = Math.max(0, input.maxUnits);
	let best: FittingCandidate<T> | null = null;

	while (low <= high) {
		const unitCount = Math.floor((low + high) / 2);
		const candidate = input.buildCandidate(unitCount);
		const messages = input.buildMessages(candidate);
		const tokenCount = estimateMessagesTokenCount(
			messages,
			input.estimateTokenCount,
		);
		if (tokenCount <= input.maxInputTokens) {
			best = { candidate, messages, tokenCount, unitCount };
			low = unitCount + 1;
		} else {
			high = unitCount - 1;
		}
	}

	return best;
}

function truncateMiddle(text: string, targetLength: number): string {
	if (targetLength <= 0) return "";
	if (text.length <= targetLength) return text;
	if (targetLength <= PROJECTION_TRUNCATION_MARKER.length) {
		return PROJECTION_TRUNCATION_MARKER.slice(0, targetLength);
	}

	const remaining = targetLength - PROJECTION_TRUNCATION_MARKER.length;
	const headLength = Math.ceil(remaining / 2);
	const tailLength = Math.floor(remaining / 2);
	return (
		text.slice(0, headLength) +
		PROJECTION_TRUNCATION_MARKER +
		text.slice(text.length - tailLength)
	);
}

function withUpdatedProjection(
	payload: Record<string, unknown>,
	projection: string,
): Record<string, unknown> {
	return {
		...payload,
		projection,
	};
}

function maybeOmitCurrentPageScreenshotFlag(
	payload: Record<string, unknown>,
	currentPageScreenshotDataUrl?: string,
): Record<string, unknown> {
	if (currentPageScreenshotDataUrl) return payload;
	const nextPayload = { ...payload };
	delete nextPayload.currentPageScreenshotIncludedAsImagePart;
	return nextPayload;
}

function stripProjectionContextFromHistoryMessages(
	history: Message[],
): Message[] {
	return history.map((message) => {
		if (message.role !== "user" || typeof message.content !== "string") {
			return message;
		}
		let parsed: unknown;
		try {
			parsed = yaml.load(message.content);
		} catch {
			return message;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return message;
		}
		const payload = { ...(parsed as Record<string, unknown>) };
		stripProjectionContextFromHistoryPayload(payload);
		return { ...message, content: yaml.dump(payload) };
	});
}

function buildAndCountMessages(params: {
	systemPrompt: string;
	history: Message[];
	payload: Record<string, unknown>;
	buildStepMessages: typeof buildStepMessages;
	estimateTokenCount: (text: string) => number;
	currentPageScreenshotDataUrl?: string;
}): { messages: Message[]; tokenCount: number } {
	const messages = params.buildStepMessages({
		systemPrompt: params.systemPrompt,
		history: params.history,
		payload: params.payload,
		currentPageScreenshotDataUrl: params.currentPageScreenshotDataUrl,
	});
	return {
		messages,
		tokenCount: estimateMessagesTokenCount(
			messages,
			params.estimateTokenCount,
		),
	};
}

export function fitStepPromptToBudget(
	input: FitStepPromptToBudgetInput,
): FitStepPromptToBudgetResult {
	const maxInputTokens = resolveMaxInputTokens(input.llmOptions);
	let payload = { ...input.payload };
	let history = [...input.history];
	let currentPageScreenshotDataUrl = input.currentPageScreenshotDataUrl;

	let built = buildAndCountMessages({
		systemPrompt: input.systemPrompt,
		history,
		payload,
		buildStepMessages: input.buildStepMessages,
		estimateTokenCount: input.estimateTokenCount,
		currentPageScreenshotDataUrl,
	});
	const initialInputTokens = built.tokenCount;
	const reductions: string[] = [];
	const toResult = (): FitStepPromptToBudgetResult => ({
		messages: built.messages,
		payload,
		currentPageScreenshotDataUrl,
		budgetReport: {
			maxInputTokens,
			initialInputTokens,
			finalInputTokens: built.tokenCount,
			reductions: [...reductions],
		},
	});

	if (maxInputTokens === null || built.tokenCount <= maxInputTokens) {
		return toResult();
	}

	if (currentPageScreenshotDataUrl) {
		currentPageScreenshotDataUrl = undefined;
		payload = maybeOmitCurrentPageScreenshotFlag(
			payload,
			currentPageScreenshotDataUrl,
		);
		reductions.push("drop_current_page_screenshot");
		built = buildAndCountMessages({
			systemPrompt: input.systemPrompt,
			history,
			payload,
			buildStepMessages: input.buildStepMessages,
			estimateTokenCount: input.estimateTokenCount,
			currentPageScreenshotDataUrl,
		});
		if (built.tokenCount <= maxInputTokens) {
			return toResult();
		}
	}

	if (
		input.projectionHistoryContext?.enabled &&
		payload.projectionContextMode === "delta" &&
		built.tokenCount > maxInputTokens
	) {
		history = stripProjectionContextFromHistoryMessages(history);
		payload = {
			...payload,
			projectionContextMode: "reset",
			projection: input.projectionHistoryContext.canonicalProjection,
		};
		reductions.push("checkpoint_cumulative_projection_history");
		built = buildAndCountMessages({
			systemPrompt: input.systemPrompt,
			history,
			payload,
			buildStepMessages: input.buildStepMessages,
			estimateTokenCount: input.estimateTokenCount,
			currentPageScreenshotDataUrl,
		});
	}

	if (!input.projectionHistoryContext?.enabled) {
		while (history.length > 0 && built.tokenCount > maxInputTokens) {
			history = history.slice(Math.min(2, history.length));
			reductions.push("drop_oldest_history_pair");
			built = buildAndCountMessages({
				systemPrompt: input.systemPrompt,
				history,
				payload,
				buildStepMessages: input.buildStepMessages,
				estimateTokenCount: input.estimateTokenCount,
				currentPageScreenshotDataUrl,
			});
		}
	}

	const projection =
		typeof payload.projection === "string" ? payload.projection : "";
	if (built.tokenCount > maxInputTokens && projection) {
		const fitted = findLargestFittingCandidate({
			maxUnits: projection.length,
			maxInputTokens,
			buildCandidate: (unitCount) =>
				withUpdatedProjection(
					payload,
					truncateMiddle(projection, unitCount),
				),
			buildMessages: (candidatePayload) =>
				input.buildStepMessages({
					systemPrompt: input.systemPrompt,
					history,
					payload: candidatePayload,
					currentPageScreenshotDataUrl,
				}),
			estimateTokenCount: input.estimateTokenCount,
		});
		const bestProjection = String(fitted?.candidate.projection ?? "");
		payload = withUpdatedProjection(payload, bestProjection);
		reductions.push("truncate_current_projection");
		if (fitted) {
			built = {
				messages: fitted.messages,
				tokenCount: fitted.tokenCount,
			};
		} else {
			built = buildAndCountMessages({
				systemPrompt: input.systemPrompt,
				history,
				payload,
				buildStepMessages: input.buildStepMessages,
				estimateTokenCount: input.estimateTokenCount,
				currentPageScreenshotDataUrl,
			});
		}
	}

	assertPromptFits({
		messages: built.messages,
		llmOptions: input.llmOptions,
		estimateTokenCount: input.estimateTokenCount,
		caller: "executor",
	});
	return toResult();
}
