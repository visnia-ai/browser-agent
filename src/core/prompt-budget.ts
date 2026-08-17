import yaml from "js-yaml";
import type { LLMOptions, Message } from "../agents/types.js";
import type { buildStepMessages } from "../agents/executor-utils/step-execution.js";
import { stripProjectionContextFromHistoryPayload } from "../agents/executor-utils/history-payload.js";
import { isOpenAICacheMarkerPart } from "../agents/openai-prompt-cache.js";

const PROJECTION_TRUNCATION_MARKER =
	"\n...[projection truncated for context budget]...\n";
const VLLM_PROMPT_BUDGET_SAFETY_MARGIN_TOKENS = 4096;
const MESSAGE_TOKEN_OVERHEAD = 4;
const CONTENT_PART_TOKEN_OVERHEAD = 1;

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
	const estimateProviderOptions = (value: unknown): number =>
		estimateStructuredValueTokenCount(value, estimateTokenCount);
	let total = 0;
	for (const message of messages) {
		total += MESSAGE_TOKEN_OVERHEAD;
		total += estimateTokenCount(message.role);
		total += estimateProviderOptions(message.providerOptions);
		if (typeof message.content === "string") {
			total += estimateTokenCount(message.content);
			continue;
		}
		for (const part of message.content) {
			total += CONTENT_PART_TOKEN_OVERHEAD;
			total += estimateContentPartTokenCount(part, estimateTokenCount);
		}
	}
	return total;
}

function estimateFileDataTokenCount(
	data: unknown,
	estimateTokenCount: (text: string) => number,
): number {
	if (data instanceof URL) {
		return data.protocol === "data:"
			? estimateTokenCount("[inline file data]")
			: estimateTokenCount(data.toString());
	}
	if (typeof data === "string") {
		// Native screenshot parts contain bare base64 data. Counting the encoded
		// bytes as text grossly overestimates image prompts, so use a stable part
		// marker just as providers account for images independently of text tokens.
		return estimateTokenCount("[inline file data]");
	}
	if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
		return estimateTokenCount("[inline file data]");
	}
	if (!data || typeof data !== "object") {
		return 0;
	}
	const tagged = data as Record<string, unknown>;
	if (tagged.type === "url") {
		return estimateFileDataTokenCount(tagged.url, estimateTokenCount);
	}
	if (tagged.type === "text" && typeof tagged.text === "string") {
		return estimateTokenCount(tagged.text);
	}
	if (tagged.type === "reference") {
		return estimateStructuredValueTokenCount(
			tagged.reference,
			estimateTokenCount,
		);
	}
	return estimateTokenCount("[inline file data]");
}

function estimateContentPartTokenCount(
	part: unknown,
	estimateTokenCount: (text: string) => number,
): number {
	if (!part || typeof part !== "object") {
		return estimateStructuredValueTokenCount(part, estimateTokenCount);
	}
	const record = part as Record<string, unknown>;
	let total =
		typeof record.type === "string" ? estimateTokenCount(record.type) : 0;
	for (const [key, value] of Object.entries(record)) {
		if (key === "type") continue;
		total += estimateTokenCount(key);
		total +=
			key === "data" &&
			(record.type === "file" || record.type === "reasoning-file")
				? estimateFileDataTokenCount(value, estimateTokenCount)
				: estimateStructuredValueTokenCount(value, estimateTokenCount);
	}
	return total;
}

function estimateStructuredValueTokenCount(
	value: unknown,
	estimateTokenCount: (text: string) => number,
	seen: Set<object> = new Set(),
): number {
	if (typeof value === "string") return estimateTokenCount(value);
	if (typeof value === "number" || typeof value === "boolean") {
		return estimateTokenCount(String(value));
	}
	if (typeof value === "bigint") return estimateTokenCount(value.toString());
	if (value instanceof URL) return estimateTokenCount(value.toString());
	if (value == null || typeof value !== "object") return 0;
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return estimateTokenCount("[binary data]");
	}
	if (seen.has(value)) return 0;
	seen.add(value);
	let total = 0;
	if (Array.isArray(value)) {
		for (const item of value) {
			total += estimateStructuredValueTokenCount(
				item,
				estimateTokenCount,
				seen,
			);
		}
	} else {
		for (const [key, item] of Object.entries(value)) {
			total += estimateTokenCount(key);
			total += estimateStructuredValueTokenCount(
				item,
				estimateTokenCount,
				seen,
			);
		}
	}
	seen.delete(value);
	return total;
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
		if (message.role !== "user") {
			return message;
		}
		const contentParts = Array.isArray(message.content)
			? message.content
			: undefined;
		const yamlTextPartIndex = contentParts?.findIndex(
			(part) => part.type === "text" && !isOpenAICacheMarkerPart(part),
		);
		const contentText =
			typeof message.content === "string"
				? message.content
				: yamlTextPartIndex !== undefined && yamlTextPartIndex >= 0
					? (contentParts?.[yamlTextPartIndex]?.type === "text"
							? contentParts[yamlTextPartIndex].text
							: undefined)
					: undefined;
		if (contentText === undefined) return message;
		let parsed: unknown;
		try {
			parsed = yaml.load(contentText);
		} catch {
			return message;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return message;
		}
		const payload = { ...(parsed as Record<string, unknown>) };
		stripProjectionContextFromHistoryPayload(payload);
		const strippedText = yaml.dump(payload);
		if (!contentParts || yamlTextPartIndex === undefined || yamlTextPartIndex < 0) {
			return { ...message, content: strippedText };
		}
		return {
			...message,
			content: contentParts.map((part, index) =>
				index === yamlTextPartIndex && part.type === "text"
					? { ...part, text: strippedText }
					: part,
			),
		};
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

function dropOldestHistoryTurn(history: Message[]): Message[] {
	if (history.length === 0) return history;
	const firstUserIndex = history.findIndex((message) => message.role === "user");
	if (firstUserIndex < 0) return [];
	const nextUserOffset = history
		.slice(firstUserIndex + 1)
		.findIndex((message) => message.role === "user");
	if (nextUserOffset < 0) return [];
	return history.slice(firstUserIndex + 1 + nextUserOffset);
}

function dropOldestReasoningParts(history: Message[]): {
	history: Message[];
	dropped: boolean;
} {
	const messageIndex = history.findIndex(
		(message) =>
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some(
				(part) =>
					part.type === "reasoning" || part.type === "reasoning-file",
			),
	);
	if (messageIndex < 0) return { history, dropped: false };
	return {
		history: history.map((message, index): Message => {
			if (
				index !== messageIndex ||
				message.role !== "assistant" ||
				!Array.isArray(message.content)
			) {
				return message;
			}
			return {
				...message,
				content: message.content.filter(
					(part) =>
						part.type !== "reasoning" && part.type !== "reasoning-file",
				),
			};
		}),
		dropped: true,
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

	while (history.length > 0 && built.tokenCount > maxInputTokens) {
		const next = dropOldestReasoningParts(history);
		if (!next.dropped) break;
		history = next.history;
		reductions.push("drop_oldest_reasoning");
		built = buildAndCountMessages({
			systemPrompt: input.systemPrompt,
			history,
			payload,
			buildStepMessages: input.buildStepMessages,
			estimateTokenCount: input.estimateTokenCount,
			currentPageScreenshotDataUrl,
		});
	}

	while (history.length > 0 && built.tokenCount > maxInputTokens) {
		history = dropOldestHistoryTurn(history);
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
