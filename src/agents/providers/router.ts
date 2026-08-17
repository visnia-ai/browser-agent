import yaml from "js-yaml";
import type {
	ContentPart,
	Message,
	LLMOptions,
	TokenUsage,
	ChatJSONResult,
	ChatYAMLTraceEvent,
	OpenAIPromptCacheRequest,
} from "../types.js";
import type { ModelMessage } from "ai";
import { runProviderChat } from "./ai-sdk.js";
import { estimateTokenCount } from "../prompt-token-estimator.js";
import { assertPromptFits } from "../../core/prompt-budget.js";
import { logActionBoundary } from "../executor-utils/action-boundary-logging.js";
import { featureFlags } from "../../featureFlags.js";

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 500;
const DEFAULT_CHAT_YAML_HARD_TIMEOUT_MS = 300_000;
const DEFAULT_CHAT_YAML_STALL_LOG_INTERVAL_MS = 5_000;

const CHAT_YAML_HARD_TIMEOUT_MS_ENV = "BROWSER_AGENT_CHAT_YAML_HARD_TIMEOUT_MS";
const CHAT_YAML_STALL_LOG_INTERVAL_MS_ENV =
	"BROWSER_AGENT_CHAT_YAML_STALL_LOG_INTERVAL_MS";

function combineTokenUsage(usages: TokenUsage[]): TokenUsage {
	const combined: TokenUsage = {
		input_tokens: 0,
		cached_input_tokens: 0,
		cache_write_tokens: 0,
		output_tokens: 0,
		total_tokens: 0,
	};
	let hasReasoningTokens = false;
	let hasNonReasoningOutputTokens = false;
	let hasGenerationTime = false;
	let hasTimeToFirstToken = false;
	for (const usage of usages) {
		combined.input_tokens += usage.input_tokens;
		combined.cached_input_tokens =
			(combined.cached_input_tokens ?? 0) +
			(usage.cached_input_tokens ?? 0);
		combined.cache_write_tokens =
			(combined.cache_write_tokens ?? 0) +
			(usage.cache_write_tokens ?? 0);
		combined.output_tokens += usage.output_tokens;
		combined.total_tokens += usage.total_tokens;
		if (typeof usage.reasoning_tokens === "number") {
			hasReasoningTokens = true;
			combined.reasoning_tokens =
				(combined.reasoning_tokens ?? 0) + usage.reasoning_tokens;
		}
		if (typeof usage.non_reasoning_output_tokens === "number") {
			hasNonReasoningOutputTokens = true;
			combined.non_reasoning_output_tokens =
				(combined.non_reasoning_output_tokens ?? 0) +
				usage.non_reasoning_output_tokens;
		}
		if (typeof usage.generation_time_ms === "number") {
			hasGenerationTime = true;
			combined.generation_time_ms =
				(combined.generation_time_ms ?? 0) + usage.generation_time_ms;
		}
		if (typeof usage.time_to_first_token_ms === "number") {
			hasTimeToFirstToken = true;
			combined.time_to_first_token_ms = usage.time_to_first_token_ms;
		}
	}
	if (!hasReasoningTokens) delete combined.reasoning_tokens;
	if (!hasNonReasoningOutputTokens) {
		delete combined.non_reasoning_output_tokens;
	}
	if (!hasGenerationTime) delete combined.generation_time_ms;
	if (!hasTimeToFirstToken) delete combined.time_to_first_token_ms;
	return combined;
}

type ChatYAMLRequestPhase =
	| "awaiting_first_token"
	| "streaming"
	| "awaiting_usage"
	| "parsing";

type ChatYAMLLogValue = string | number | boolean | undefined;

function logChatYAMLEvent(
	event: string,
	fields: Record<string, ChatYAMLLogValue>,
): void {
	const details = Object.entries(fields)
		.filter(
			(entry): entry is [string, string | number | boolean] =>
				entry[1] !== undefined,
		)
		.map(([key, value]) =>
			typeof value === "string"
				? `${key}=${JSON.stringify(value)}`
				: `${key}=${value}`,
		)
		.join(" ");
	console.log(`[LLM][chatYAML] event=${event}${details ? ` ${details}` : ""}`);
}

function getErrorName(error: unknown): string {
	if (error instanceof Error && error.name) return error.name;
	return typeof error;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class ChatYAMLHardTimeoutError extends Error {
	constructor(input: {
		provider: LLMOptions["provider"];
		caller: string;
		attempt: number;
		timeoutMs: number;
	}) {
		super(
			`chatYAML hard timeout (provider=${input.provider}, caller=${input.caller}, attempt=${input.attempt}, timeoutMs=${input.timeoutMs})`,
		);
		this.name = "ChatYAMLHardTimeoutError";
	}
}

class ChatYAMLAbortError extends Error {
	constructor(reason?: unknown) {
		super(
			reason instanceof Error ? reason.message : "Browser agent run cancelled.",
		);
		this.name = "AbortError";
	}
}

function isAbortError(error: unknown) {
	return (
		error instanceof Error &&
		(error.name === "AbortError" ||
			error.message === "Browser agent run cancelled.")
	);
}

function readPositiveIntEnv(name: string): number | null {
	const rawValue = process.env[name];
	if (rawValue === undefined) {
		return null;
	}
	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return null;
	}
	return parsed;
}

function getChatYAMLHardTimeoutMs(): number {
	return (
		readPositiveIntEnv(CHAT_YAML_HARD_TIMEOUT_MS_ENV) ??
		DEFAULT_CHAT_YAML_HARD_TIMEOUT_MS
	);
}

function getChatYAMLStallLogIntervalMs(): number {
	return (
		readPositiveIntEnv(CHAT_YAML_STALL_LOG_INTERVAL_MS_ENV) ??
		DEFAULT_CHAT_YAML_STALL_LOG_INTERVAL_MS
	);
}

async function withRetries<T>(
	operation: string,
	fn: (attempt: number) => Promise<T>,
	onRetry?: (input: {
		attempt: number;
		backoffMs: number;
		error: unknown;
	}) => void,
	shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await fn(attempt);
		} catch (error) {
			lastError = error;
			if (isAbortError(error)) {
				throw error;
			}
			if (!shouldRetry(error)) {
				throw error;
			}
			if (attempt === MAX_RETRIES) {
				break;
			}

			const backoffMs = BASE_RETRY_DELAY_MS * attempt;
			onRetry?.({ attempt, backoffMs, error });
			console.log(
				`[LLM] ${operation} failed (attempt ${attempt}/${MAX_RETRIES}, error_name=${getErrorName(
					error,
				)}, retry_backoff_ms=${backoffMs}). Retrying...`,
			);
			await sleep(backoffMs);
		}
	}

	throw new Error(
		`[LLM] ${operation} failed after ${MAX_RETRIES} attempts: ${toErrorMessage(lastError)}`,
	);
}

/** Build a native AI SDK user message. */
export function userMessage(content: string | ContentPart[]): Message {
	return { role: "user", content };
}

export async function chat(
	messages: Message[],
	options: LLMOptions,
): Promise<string> {
	const { provider, model } = options;
	assertPromptFits({
		messages,
		llmOptions: options,
		estimateTokenCount,
		caller: "chat",
	});

	return withRetries(`chat:${provider}`, async () => {
		const result = await runProviderChat({
			options: { ...options, model },
			messages,
		});
		return result.content;
	});
}

/** Strip markdown code blocks from LLM response */
function stripMarkdownCodeBlocks(content: string): string {
	const match = content.match(/^```(?:ya?ml|json)?\s*\n?([\s\S]*?)\n?```$/);
	if (match) {
		return match[1].trim();
	}
	return content.trim();
}

/**
 * If the response contains <yaml>, keep everything after that marker.
 * If a legacy closing </yaml> exists, trim to its start.
 * Otherwise return the original content unchanged.
 */
function extractYAMLTagContent(content: string): string {
	const openTag = content.match(/<yaml\b[^>]*>/i);
	if (!openTag || openTag.index === undefined) {
		return content;
	}

	const afterOpenTag = content.slice(openTag.index + openTag[0].length);
	const closeTagIndex = afterOpenTag.search(/<\/yaml>/i);
	const extracted =
		closeTagIndex >= 0 ? afterOpenTag.slice(0, closeTagIndex) : afterOpenTag;
	return extracted.trim();
}

const YAML_TEXT_LIKE_SCALAR_KEYS = new Set([
	"thinking",
	"text",
	"link",
	"summary",
	"downloaded_file_path",
	"type",
	"url",
	"script",
	"reason",
	"value",
	"previousStepOutcome",
	"currentStateObservation",
	"nextActionRationale",
]);

const YAML_ADVISORY_STEP_CONTEXT_KEY_LIST = [
	"previousStepStatus",
	"previousStepOutcome",
	"currentStateObservation",
	"nextActionRationale",
] as const;

type AdvisoryStepContextKey =
	(typeof YAML_ADVISORY_STEP_CONTEXT_KEY_LIST)[number];

const YAML_ADVISORY_STEP_CONTEXT_KEYS = new Set<AdvisoryStepContextKey>(
	YAML_ADVISORY_STEP_CONTEXT_KEY_LIST,
);

function repairUnquotedTextLikeYamlScalars(content: string): string {
	let changed = false;
	const repaired = content
		.split("\n")
		.map((line) => {
			const match = line.match(
				/^(\s*(?:-\s*)?)([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*?)\s*$/,
			);
			if (!match) {
				return line;
			}

			const [, prefix, key, rawValue] = match;
			if (!YAML_TEXT_LIKE_SCALAR_KEYS.has(key) || rawValue.length === 0) {
				return line;
			}
			if (/^["'|>\[{]/.test(rawValue)) {
				return line;
			}

			changed = true;
			return `${prefix}${key}: ${JSON.stringify(rawValue)}`;
		})
		.join("\n");

	return changed ? repaired : content;
}

function tryDecodeYamlScalarText(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return "";
	}
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		try {
			const parsed = yaml.load(`v: ${trimmed}`) as { v?: unknown } | null;
			if (parsed && typeof parsed.v === "string") {
				return parsed.v.trim();
			}
		} catch {
			// Fall back to the raw trimmed text below.
		}
	}
	return trimmed;
}

function extractBlockScalarText(
	lines: string[],
	startIndex: number,
): {
	value: string;
	nextIndex: number;
} {
	const collected: string[] = [];
	let index = startIndex + 1;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (line.length === 0) {
			collected.push("");
			index += 1;
			continue;
		}
		if (/^\s/.test(line)) {
			collected.push(line.replace(/^\s+/, ""));
			index += 1;
			continue;
		}
		break;
	}
	return {
		value: collected.join("\n").trim(),
		nextIndex: index,
	};
}

function stripAndSalvageAdvisoryStepContextFields(content: string): {
	content: string;
	salvaged: Partial<Record<AdvisoryStepContextKey, string>>;
	changed: boolean;
} {
	const salvaged: Partial<Record<AdvisoryStepContextKey, string>> = {};
	const output: string[] = [];
	const lines = content.split("\n");
	let changed = false;

	for (let index = 0; index < lines.length; ) {
		const line = lines[index] ?? "";
		const match = line.match(
			/^(previousStepStatus|previousStepOutcome|currentStateObservation|nextActionRationale):\s*(.*)$/,
		);
		if (!match) {
			output.push(line);
			index += 1;
			continue;
		}

		const key = match[1] as AdvisoryStepContextKey;
		const rawValue = match[2] ?? "";
		changed = true;

		if (/^[|>][-+0-9\s]*$/.test(rawValue.trim())) {
			const extracted = extractBlockScalarText(lines, index);
			salvaged[key] = extracted.value;
			index = extracted.nextIndex;
			continue;
		}

		salvaged[key] = tryDecodeYamlScalarText(rawValue);
		index += 1;
		while (index < lines.length) {
			const nextLine = lines[index] ?? "";
			if (nextLine.length === 0) {
				index += 1;
				continue;
			}
			if (/^\s/.test(nextLine)) {
				index += 1;
				continue;
			}
			break;
		}
	}

	return {
		content: output.join("\n"),
		salvaged,
		changed,
	};
}

function mergeSalvagedAdvisoryStepContextFields<T>(
	parsed: T,
	salvaged: Partial<Record<AdvisoryStepContextKey, string>>,
): T {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return parsed;
	}
	const target = parsed as Record<string, unknown>;
	for (const key of YAML_ADVISORY_STEP_CONTEXT_KEY_LIST) {
		if (target[key] !== undefined) {
			continue;
		}
		const salvagedValue = salvaged[key];
		if (salvagedValue === undefined) {
			continue;
		}
		target[key] = salvagedValue;
	}
	return parsed;
}

export async function chatYAML<T>(
	messages: Message[],
	options: LLMOptions,
	caller?: string,
	onTrace?: (trace: ChatYAMLTraceEvent<T>) => void,
	abortSignal?: AbortSignal,
	onOutputChunk?: (chunk: string) => void,
	openAIEncryptedResponses?: boolean,
	openAIPromptCache?: OpenAIPromptCacheRequest,
): Promise<ChatJSONResult<T>> {
	const { provider, model } = options;
	const usesOpenAIPromptCachePolicy =
		provider === "openai" && openAIPromptCache !== undefined;
	const resolvedCaller = caller || "unknown";
	assertPromptFits({
		messages,
		llmOptions: options,
		estimateTokenCount,
		caller: resolvedCaller,
	});
	const operationStartedAt = Date.now();
	let lastAttempt = 0;
	const attemptUsages: TokenUsage[] = [];

	try {
		const result = await withRetries(
			`chatYAML:${resolvedCaller}`,
			async (attempt) => {
				lastAttempt = attempt;
				let content = "";
				let usage: TokenUsage = {
					input_tokens: 0,
					output_tokens: 0,
					total_tokens: 0,
				};
				let reasoning_tokens = "";
				let responseMessages: ModelMessage[] = [];
				const attemptStartedAt = Date.now();
				const hardTimeoutMs = getChatYAMLHardTimeoutMs();
				const stallLogIntervalMs = getChatYAMLStallLogIntervalMs();
				let requestPhase: ChatYAMLRequestPhase = "awaiting_first_token";
				let firstDeltaMs: number | undefined;
				let firstTextDeltaMs: number | undefined;
				let streamedChunkCount = 0;
				let streamedOutputCharacters = 0;

				logChatYAMLEvent("request_start", {
					caller: resolvedCaller,
					provider,
					model,
					attempt,
					retry_count: attempt - 1,
					message_count: messages.length,
					encrypted_responses:
						provider === "openai" && openAIEncryptedResponses === true,
					prompt_cache_mode: usesOpenAIPromptCachePolicy
						? "explicit"
						: provider === "openai"
							? "implicit"
							: "disabled",
					hard_timeout_ms: hardTimeoutMs,
				});

				const heartbeatHandle: ReturnType<typeof setInterval> = setInterval(
					() => {
						logChatYAMLEvent("heartbeat", {
							caller: resolvedCaller,
							provider,
							model,
							attempt,
							phase: requestPhase,
							elapsed_ms: Date.now() - attemptStartedAt,
							chunk_count: streamedChunkCount,
							output_characters: streamedOutputCharacters,
						});
					},
					stallLogIntervalMs,
				);
				if (
					typeof heartbeatHandle === "object" &&
					heartbeatHandle !== null &&
					"unref" in heartbeatHandle &&
					typeof heartbeatHandle.unref === "function"
				) {
					heartbeatHandle.unref();
				}

				const abortController = new AbortController();
				let hardTimedOut = false;
				let externalAbortReject: ((error: ChatYAMLAbortError) => void) | null =
					null;
				const externalAbortPromise = new Promise<never>((_, reject) => {
					externalAbortReject = reject;
				});
				const handleExternalAbort = () => {
					abortController.abort(abortSignal?.reason);
					externalAbortReject?.(new ChatYAMLAbortError(abortSignal?.reason));
				};
				if (abortSignal?.aborted) {
					handleExternalAbort();
				} else {
					abortSignal?.addEventListener("abort", handleExternalAbort, {
						once: true,
					});
				}

				let rejectHardTimeout:
					| ((error: ChatYAMLHardTimeoutError) => void)
					| null = null;
				const hardTimeoutPromise = new Promise<never>((_, reject) => {
					rejectHardTimeout = reject;
				});
				const hardTimeoutHandle: ReturnType<typeof setTimeout> = setTimeout(
					() => {
						hardTimedOut = true;
						logChatYAMLEvent("hard_timeout", {
							caller: resolvedCaller,
							provider,
							model,
							attempt,
							phase: requestPhase,
							elapsed_ms: Date.now() - attemptStartedAt,
							timeout_ms: hardTimeoutMs,
						});
						abortController.abort();
						rejectHardTimeout?.(
							new ChatYAMLHardTimeoutError({
								provider,
								caller: resolvedCaller,
								attempt,
								timeoutMs: hardTimeoutMs,
							}),
						);
					},
					hardTimeoutMs,
				);
				if (
					typeof hardTimeoutHandle === "object" &&
					hardTimeoutHandle !== null &&
					"unref" in hardTimeoutHandle &&
					typeof hardTimeoutHandle.unref === "function"
				) {
					hardTimeoutHandle.unref();
				}

				try {
					await Promise.race([
						(async () => {
							({
								content,
								usage,
								reasoning_tokens,
								responseMessages,
							} = await runProviderChat({
								options: { ...options, model },
								messages,
								openAIEncryptedResponses:
									provider === "openai"
										? openAIEncryptedResponses
										: undefined,
								openAIPromptCache: usesOpenAIPromptCachePolicy
									? openAIPromptCache
									: undefined,
								abortSignal: abortController.signal,
								onOutputChunk,
								outputStopSequences: featureFlags.yamlOutputStopSequences,
								onLifecycleEvent: (event) => {
									const elapsedMs = Date.now() - attemptStartedAt;
									if (event.type === "first_delta") {
										if (firstDeltaMs === undefined) {
											firstDeltaMs = elapsedMs;
										}
										requestPhase = "streaming";
										logChatYAMLEvent("first_delta", {
											caller: resolvedCaller,
											provider,
											model,
											attempt,
											delta_type: event.deltaType,
											elapsed_ms: elapsedMs,
										});
										return;
									}
									if (event.type === "first_text_delta") {
										if (firstTextDeltaMs === undefined) {
											firstTextDeltaMs = elapsedMs;
										}
										requestPhase = "streaming";
										logChatYAMLEvent("first_text_delta", {
											caller: resolvedCaller,
											provider,
											model,
											attempt,
											elapsed_ms: elapsedMs,
										});
										return;
									}
									if (event.type === "output_stop_sequence") {
										logChatYAMLEvent("output_stop_sequence", {
											caller: resolvedCaller,
											provider,
											model,
											attempt,
											elapsed_ms: elapsedMs,
											sequence: event.sequence,
										});
										return;
									}
									if (event.type === "text_stream_complete") {
										streamedChunkCount = event.chunkCount;
										streamedOutputCharacters = event.outputCharacters;
										requestPhase = "awaiting_usage";
										logChatYAMLEvent("text_stream_complete", {
											caller: resolvedCaller,
											provider,
											model,
											attempt,
											elapsed_ms: elapsedMs,
											chunk_count: streamedChunkCount,
											output_characters: streamedOutputCharacters,
										});
										return;
									}
									logChatYAMLEvent("usage_complete", {
										caller: resolvedCaller,
										provider,
										model,
										attempt,
										elapsed_ms: elapsedMs,
									});
								},
							}));
						})(),
						hardTimeoutPromise,
						externalAbortPromise,
					]);
				} catch (error) {
					logChatYAMLEvent("request_error", {
						caller: resolvedCaller,
						provider,
						model,
						attempt,
						phase: requestPhase,
						elapsed_ms: Date.now() - attemptStartedAt,
						error_name: getErrorName(error),
						hard_timeout: hardTimedOut,
					});
					onTrace?.({
						caller: resolvedCaller,
						provider,
						model,
						attempt,
						messages,
						raw_response: content || undefined,
						usage,
						reasoning_tokens,
						error: toErrorMessage(error),
					});
					if (hardTimedOut) {
						throw error;
					}
					if (isAbortError(error)) {
						throw error;
					}
					throw error;
				} finally {
					clearInterval(heartbeatHandle);
					clearTimeout(hardTimeoutHandle);
					abortSignal?.removeEventListener("abort", handleExternalAbort);
					if (hardTimedOut) {
						abortController.abort();
					}
				}

				const generationTimeMs = Date.now() - attemptStartedAt;
				usage.generation_time_ms = generationTimeMs;
				if (firstDeltaMs !== undefined) {
					usage.time_to_first_token_ms = firstDeltaMs;
				}
				attemptUsages.push({ ...usage });
				logChatYAMLEvent("provider_complete", {
					caller: resolvedCaller,
					provider,
					model,
					attempt,
					elapsed_ms: generationTimeMs,
					time_to_first_token_ms: firstDeltaMs,
					time_to_first_text_ms: firstTextDeltaMs,
					input_tokens: usage.input_tokens,
					cached_input_tokens: usage.cached_input_tokens,
					cache_write_tokens: usage.cache_write_tokens,
					output_tokens: usage.output_tokens,
					total_tokens: usage.total_tokens,
				});

				requestPhase = "parsing";
				const parseStartedAt = Date.now();
				logChatYAMLEvent("parse_start", {
					caller: resolvedCaller,
					provider,
					model,
					attempt,
					response_characters: content.length,
				});
				logActionBoundary("chat_yaml_input", {
					caller: resolvedCaller,
					content_after_reasoning_split: content,
					reasoning_tokens,
				});
				const contentWithExtractedYAML = extractYAMLTagContent(content);
				const cleanContent = stripMarkdownCodeBlocks(contentWithExtractedYAML);

				try {
					const parsed = yaml.load(cleanContent);
					if (
						parsed === null ||
						parsed === undefined ||
						typeof parsed !== "object" ||
						Array.isArray(parsed)
					) {
						throw new Error(
							`Expected a YAML object, got ${
								parsed === null
									? "null"
									: Array.isArray(parsed)
										? "array"
										: typeof parsed
							}`,
						);
					}
					logChatYAMLEvent("parse_complete", {
						caller: resolvedCaller,
						provider,
						model,
						attempt,
						parse_ms: Date.now() - parseStartedAt,
						repair: "none",
					});
					logActionBoundary("yaml_parsed", {
						caller: resolvedCaller,
						raw_response: cleanContent,
						reasoning_tokens,
						parsed_output: parsed,
					});
					onTrace?.({
						caller: resolvedCaller,
						provider,
						model,
						attempt,
						messages,
						output: parsed as T,
						raw_response: cleanContent,
						usage,
						reasoning_tokens,
					});
						return {
							data: parsed as T,
							usage: combineTokenUsage(attemptUsages),
							accepted_usage: usage,
							reasoning_tokens,
							raw_response: content,
							responseMessages,
						};
				} catch (e) {
					const repairedContent =
						repairUnquotedTextLikeYamlScalars(cleanContent);
					if (repairedContent !== cleanContent) {
						try {
							const repairedParsed = yaml.load(repairedContent);
							if (
								repairedParsed !== null &&
								repairedParsed !== undefined &&
								typeof repairedParsed === "object" &&
								!Array.isArray(repairedParsed)
							) {
								logChatYAMLEvent("parse_complete", {
									caller: resolvedCaller,
									provider,
									model,
									attempt,
									parse_ms: Date.now() - parseStartedAt,
									repair: "unquoted_scalars",
								});
								logActionBoundary("yaml_parsed", {
									caller: resolvedCaller,
									raw_response: repairedContent,
									reasoning_tokens,
									parsed_output: repairedParsed,
									repair: "unquoted_scalars",
								});
								onTrace?.({
									caller: resolvedCaller,
									provider,
									model,
									attempt,
									messages,
									output: repairedParsed as T,
									raw_response: repairedContent,
									usage,
									reasoning_tokens,
								});
								return {
									data: repairedParsed as T,
									usage: combineTokenUsage(attemptUsages),
									accepted_usage: usage,
									reasoning_tokens,
									raw_response: content,
									responseMessages,
								};
							}
						} catch {
							// Fall through to the original parse error below.
						}
					}

					const strippedSummaryFields =
						stripAndSalvageAdvisoryStepContextFields(cleanContent);
					if (strippedSummaryFields.changed) {
						try {
							const strippedParsed = yaml.load(strippedSummaryFields.content);
							if (
								strippedParsed !== null &&
								strippedParsed !== undefined &&
								typeof strippedParsed === "object" &&
								!Array.isArray(strippedParsed)
							) {
								const mergedParsed = mergeSalvagedAdvisoryStepContextFields(
									strippedParsed as T,
									strippedSummaryFields.salvaged,
								);
								logChatYAMLEvent("parse_complete", {
									caller: resolvedCaller,
									provider,
									model,
									attempt,
									parse_ms: Date.now() - parseStartedAt,
									repair: "advisory_fields",
								});
								logActionBoundary("yaml_parsed", {
									caller: resolvedCaller,
									raw_response: cleanContent,
									reasoning_tokens,
									parsed_output: mergedParsed,
									repair: "advisory_fields",
								});
								onTrace?.({
									caller: resolvedCaller,
									provider,
									model,
									attempt,
									messages,
									output: mergedParsed,
									raw_response: cleanContent,
									usage,
									reasoning_tokens,
								});
								return {
									data: mergedParsed,
									usage: combineTokenUsage(attemptUsages),
									accepted_usage: usage,
									reasoning_tokens,
									raw_response: content,
									responseMessages,
								};
							}
						} catch {
							// Fall through to the original parse error below.
						}
					}

					const location = caller || "unknown";
					logChatYAMLEvent("parse_error", {
						caller: resolvedCaller,
						provider,
						model,
						attempt,
						parse_ms: Date.now() - parseStartedAt,
						error_name: getErrorName(e),
					});
					onTrace?.({
						caller: resolvedCaller,
						provider,
						model,
						attempt,
						messages,
						raw_response: cleanContent,
						usage,
						reasoning_tokens,
						error: `YAML parse error in ${location}: ${(e as Error).message}`,
					});
					throw new Error(
						`YAML parse error in ${location}: ${(e as Error).message}`,
					);
				}
			},
			({ attempt, backoffMs, error }) => {
				logChatYAMLEvent("retry_backoff", {
					caller: resolvedCaller,
					provider,
					model,
					attempt,
					backoff_ms: backoffMs,
					error_name: getErrorName(error),
				});
			},
		);
		logChatYAMLEvent("operation_complete", {
			caller: resolvedCaller,
			provider,
			model,
			attempts: lastAttempt,
			elapsed_ms: Date.now() - operationStartedAt,
		});
		return result;
	} catch (error) {
		logChatYAMLEvent("operation_error", {
			caller: resolvedCaller,
			provider,
			model,
			attempts: lastAttempt,
			elapsed_ms: Date.now() - operationStartedAt,
			error_name: getErrorName(error),
		});
		throw error;
	}
}
