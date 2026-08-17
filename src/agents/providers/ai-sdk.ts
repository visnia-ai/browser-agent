import {
	generateText,
	LanguageModelUsage,
	type ModelMessage,
	type ProviderMetadata,
	type ReasoningFileOutput,
	type ReasoningOutput,
	streamText,
	type StreamTextTransform,
	type TextStreamPart,
	type ToolSet,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { randomUUID } from "node:crypto";
import type {
	LLMOptions,
	OpenAIPromptCacheRequest,
	Provider,
	TokenUsage,
} from "../types.js";
import {
	getReasoningModelCapability,
	validateReasoningConfiguration,
} from "../reasoning-capabilities.js";
import { logActionBoundary } from "../executor-utils/action-boundary-logging.js";
import { featureFlags } from "../../featureFlags.js";

const TOGETHER_DEFAULT_BASE_URL = "https://api.together.xyz/v1";
const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface CodexCredentials {
	accessToken: string;
	accountId: string;
	version: string;
}

export interface CodexProviderRuntime {
	getCredentials(): Promise<CodexCredentials>;
	refreshCredentials(): Promise<CodexCredentials | void>;
	close?(): Promise<void>;
}

export const SUPPORTED_MODEL_PROVIDERS = [
	{
		id: "openai",
		adapter: "openai",
		requiresApiKey: true,
	},
	{
		id: "codex",
		adapter: "codex",
		requiresApiKey: false,
	},
	{
		id: "vllm",
		adapter: "openai-compatible",
		requiresApiKey: false,
	},
	{
		id: "anthropic",
		adapter: "anthropic",
		requiresApiKey: true,
	},
	{
		id: "google",
		adapter: "google",
		requiresApiKey: true,
	},
	{
		id: "together",
		adapter: "openai-compatible",
		requiresApiKey: true,
	},
	{
		id: "openrouter",
		adapter: "openrouter",
		requiresApiKey: true,
	},
] as const;

type ProviderDefinition = (typeof SUPPORTED_MODEL_PROVIDERS)[number];

type ProviderAdapter = ProviderDefinition["adapter"];

interface ProviderRuntimeConfig {
	provider: Provider;
	adapter: ProviderAdapter;
	apiKey?: string;
	endpointUrl?: string;
}

type AssistantContentParts = Exclude<
	Extract<ModelMessage, { role: "assistant" }>["content"],
	string
>;

function findLastAssistantMessageIndex(messages: ModelMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "assistant") return index;
	}
	return -1;
}

function buildOpenRouterModelSettings() {
	return { usage: { include: true } } as const;
}

export interface ProviderChatArgs {
	options: LLMOptions;
	messages: ModelMessage[];
	openAIEncryptedResponses?: boolean;
	openAIPromptCache?: OpenAIPromptCacheRequest;
	abortSignal?: AbortSignal;
	onOutputChunk?: (chunk: string) => void;
	/** Final-text-only stop sequences. Reasoning deltas are never searched. */
	outputStopSequences?: readonly string[];
	onLifecycleEvent?: (event: ProviderChatLifecycleEvent) => void;
}

export interface ProviderChatResult {
	content: string;
	usage: TokenUsage;
	reasoning_tokens: string;
	responseMessages: ModelMessage[];
}

export type ProviderChatLifecycleEvent =
	| {
			type: "first_delta";
			deltaType: "text" | "reasoning";
	  }
	| { type: "first_text_delta" }
	| { type: "output_stop_sequence"; sequence: string }
	| {
			type: "text_stream_complete";
			chunkCount: number;
			outputCharacters: number;
	  }
	| { type: "usage_complete" };

let codexProviderRuntime: CodexProviderRuntime | null = null;
let codexRefreshPromise: Promise<CodexCredentials> | null = null;
const codexSessionId = randomUUID();
let providerChatOverride:
	| ((args: ProviderChatArgs) => Promise<ProviderChatResult>)
	| null = null;
const perProviderOverrides = new Map<
	Provider,
	((args: ProviderChatArgs) => Promise<ProviderChatResult>) | null
>();

function getProviderDefinition(provider: Provider): ProviderDefinition {
	const definition = SUPPORTED_MODEL_PROVIDERS.find(
		(entry) => entry.id === provider,
	);
	if (!definition) {
		throw new Error(`Unsupported provider '${provider}'.`);
	}
	return definition;
}

function readEnvString(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveEnvApiKey(provider: Provider): string | undefined {
	if (provider === "codex") {
		return undefined;
	}
	if (provider === "openai") {
		return readEnvString("OPENAI_API_KEY");
	}
	if (provider === "anthropic") {
		return readEnvString("ANTHROPIC_API_KEY");
	}
	if (provider === "google") {
		return readEnvString("GOOGLE_API_KEY");
	}
	if (provider === "together") {
		return readEnvString("TOGETHER_API_KEY");
	}
	if (provider === "openrouter") {
		return readEnvString("OPENROUTER_API_KEY");
	}
	return readEnvString("VLLM_API_KEY") || readEnvString("OPENAI_API_KEY");
}

function resolveApiKey(options: LLMOptions): string | undefined {
	const explicitApiKey = options.apiKey?.trim();
	if (explicitApiKey) {
		return explicitApiKey;
	}
	return resolveEnvApiKey(options.provider);
}

function resolveEndpointUrl(options: LLMOptions): string | undefined {
	if (options.provider === "together") {
		return options.endpointUrl || TOGETHER_DEFAULT_BASE_URL;
	}
	if (options.provider === "openrouter") {
		return options.endpointUrl || OPENROUTER_DEFAULT_BASE_URL;
	}
	if (options.provider === "vllm") {
		return options.endpointUrl || readEnvString("VLLM_BASE_URL");
	}
	return options.endpointUrl;
}

export function resolveProviderRuntimeConfig(
	options: LLMOptions,
): ProviderRuntimeConfig {
	if (
		options.openrouterProvider !== undefined &&
		(typeof options.openrouterProvider !== "string" ||
			!options.openrouterProvider.trim())
	) {
		throw new Error("openrouterProvider must be a non-empty string.");
	}
	if (
		options.openrouterProvider !== undefined &&
		options.provider !== "openrouter"
	) {
		throw new Error(
			"openrouterProvider can only be used with provider 'openrouter'.",
		);
	}
	const providerDefinition = getProviderDefinition(options.provider);
	if (options.provider === "codex" && options.apiKey !== undefined) {
		throw new Error(
			"Provider 'codex' authenticates through the Codex CLI and does not allow apiKey.",
		);
	}
	if (options.provider === "codex" && options.endpointUrl !== undefined) {
		throw new Error(
			"Provider 'codex' uses a fixed endpoint and does not allow endpointUrl.",
		);
	}
	const apiKey = resolveApiKey(options);
	const endpointUrl =
		options.provider === "codex" ? CODEX_BASE_URL : resolveEndpointUrl(options);

	if (providerDefinition.requiresApiKey && !apiKey) {
		throw new Error(
			`Missing API key for provider '${options.provider}'. Set the matching environment variable.`,
		);
	}
	if (options.provider === "vllm" && !endpointUrl) {
		throw new Error(
			"Provider 'vllm' requires endpointUrl in LLM options or VLLM_BASE_URL in the environment.",
		);
	}

	return {
		provider: options.provider,
		adapter: providerDefinition.adapter,
		apiKey,
		endpointUrl,
	};
}

export function setCodexProviderRuntime(
	runtime: CodexProviderRuntime | null,
): void {
	codexProviderRuntime = runtime;
	codexRefreshPromise = null;
}

function requireCodexProviderRuntime(): CodexProviderRuntime {
	if (!codexProviderRuntime) {
		throw new Error(
			"Codex provider authentication has not been initialized. Run Codex authentication preflight before making requests.",
		);
	}
	return codexProviderRuntime;
}

function validateCodexCredentials(
	credentials: CodexCredentials,
): CodexCredentials {
	for (const [field, value] of Object.entries(credentials)) {
		if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
			throw new Error(`Codex authentication returned an invalid ${field}.`);
		}
	}
	return credentials;
}

async function getCodexCredentials(
	runtime: CodexProviderRuntime,
): Promise<CodexCredentials> {
	return validateCodexCredentials(await runtime.getCredentials());
}

async function refreshCodexCredentials(
	runtime: CodexProviderRuntime,
	failedAccessToken: string,
): Promise<CodexCredentials> {
	const current = await getCodexCredentials(runtime);
	if (current.accessToken !== failedAccessToken) {
		return current;
	}
	if (!codexRefreshPromise) {
		codexRefreshPromise = (async () => {
			await runtime.refreshCredentials();
			return await getCodexCredentials(runtime);
		})().finally(() => {
			codexRefreshPromise = null;
		});
	}
	return await codexRefreshPromise;
}

type CodexFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function withCodexHeaders(params: {
	input: string | URL | Request;
	init?: RequestInit;
	credentials: CodexCredentials;
	requestId: string;
}): RequestInit {
	const headers = new Headers(
		params.input instanceof Request ? params.input.headers : undefined,
	);
	new Headers(params.init?.headers).forEach((value, key) => {
		headers.set(key, value);
	});
	headers.set("Authorization", `Bearer ${params.credentials.accessToken}`);
	headers.set("ChatGPT-Account-ID", params.credentials.accountId);
	headers.set("originator", "codex_cli_rs");
	headers.set("version", params.credentials.version);
	headers.set("User-Agent", `codex_cli_rs/${params.credentials.version}`);
	headers.set("session_id", codexSessionId);
	headers.set("x-client-request-id", params.requestId);
	headers.set("OpenAI-Beta", "responses=experimental");
	return { ...params.init, headers };
}

function createCodexFetch(fetchImplementation: CodexFetch): CodexFetch {
	return async (input, init) => {
		const runtime = requireCodexProviderRuntime();
		const requestId = randomUUID();
		let credentials = await getCodexCredentials(runtime);
		let response = await fetchImplementation(
			input,
			withCodexHeaders({ input, init, credentials, requestId }),
		);
		if (response.status !== 401) {
			return response;
		}
		credentials = await refreshCodexCredentials(
			runtime,
			credentials.accessToken,
		);
		response = await fetchImplementation(
			input,
			withCodexHeaders({ input, init, credentials, requestId }),
		);
		return response;
	};
}

export function __createCodexFetchForTests(
	fetchImplementation: CodexFetch,
): CodexFetch {
	return createCodexFetch(fetchImplementation);
}

function buildLanguageModel(options: {
	model: string;
	runtimeConfig: ProviderRuntimeConfig;
}) {
	if (options.runtimeConfig.adapter === "codex") {
		return createOpenAI({
			name: "codex",
			baseURL: CODEX_BASE_URL,
			apiKey: "codex-oauth",
			fetch: createCodexFetch((input, init) => fetch(input, init)),
		})(options.model);
	}
	if (options.runtimeConfig.adapter === "openrouter") {
		return createOpenRouter({
			apiKey: options.runtimeConfig.apiKey!,
			baseURL: options.runtimeConfig.endpointUrl,
			compatibility: "strict",
		}).chat(options.model, buildOpenRouterModelSettings());
	}
	if (options.runtimeConfig.adapter === "openai-compatible") {
		if (!options.runtimeConfig.endpointUrl) {
			throw new Error(
				`Provider '${options.runtimeConfig.provider}' requires endpointUrl.`,
			);
		}
		return createOpenAICompatible({
			name: `${options.runtimeConfig.provider}`,
			baseURL: options.runtimeConfig.endpointUrl,
			apiKey: options.runtimeConfig.apiKey || "EMPTY",
			includeUsage: true,
		}).chatModel(options.model);
	}
	if (options.runtimeConfig.adapter === "anthropic") {
		return createAnthropic({ apiKey: options.runtimeConfig.apiKey! })(
			options.model,
		);
	}
	if (options.runtimeConfig.adapter === "google") {
		return createGoogleGenerativeAI({
			apiKey: options.runtimeConfig.apiKey!,
		})(options.model);
	}
	return createOpenAI({
		apiKey: options.runtimeConfig.apiKey!,
		...(options.runtimeConfig.endpointUrl
			? { baseURL: options.runtimeConfig.endpointUrl }
			: {}),
	})(options.model);
}

function stripThinkBlocks(content: string): {
	cleanContent: string;
	reasoningTokens: string;
} {
	const reasoningParts: string[] = [];
	let stripped = content;

	stripped = stripped.replace(
		/<think\b[^>]*>([\s\S]*?)<\/think>/gi,
		(_match, inner: string) => {
			if (inner.trim()) {
				reasoningParts.push(inner.trim());
			}
			return "";
		},
	);

	const closingTagMatch = stripped.match(/<\/think>/i);
	if (closingTagMatch && closingTagMatch.index !== undefined) {
		const reasoningPrefix = stripped.slice(0, closingTagMatch.index).trim();
		if (reasoningPrefix) {
			reasoningParts.push(reasoningPrefix);
		}
		stripped = stripped.slice(
			closingTagMatch.index + closingTagMatch[0].length,
		);
	}

	const danglingOpenMatch = stripped.match(/<think\b[^>]*>/i);
	if (danglingOpenMatch && danglingOpenMatch.index !== undefined) {
		const reasoningSuffix = stripped
			.slice(danglingOpenMatch.index + danglingOpenMatch[0].length)
			.trim();
		if (reasoningSuffix) {
			reasoningParts.push(reasoningSuffix);
		}
		stripped = stripped.slice(0, danglingOpenMatch.index);
	}

	return {
		cleanContent: stripped.trim(),
		reasoningTokens: reasoningParts.join("\n").trim(),
	};
}

function normalizeReasoningToString(
	reasoning: Array<ReasoningOutput | ReasoningFileOutput>,
): string {
	if (!reasoning || reasoning.length === 0) {
		return "";
	}

	return reasoning
		.flatMap((part) => (part.type === "reasoning" ? [part.text] : []))
		.join("\n")
		.trim();
}

async function collectStreamedText(
	textStream: AsyncIterable<string>,
	onOutputChunk?: (chunk: string) => void,
): Promise<string[]> {
	const chunks: string[] = [];
	for await (const chunk of textStream) {
		chunks.push(chunk);
		onOutputChunk?.(chunk);
	}
	return chunks;
}

function createFinalOutputStopTransform<TOOLS extends ToolSet>(params: {
	stopSequences: readonly string[];
	onStop?: (sequence: string) => void;
}): StreamTextTransform<TOOLS> {
	const stopSequences = params.stopSequences.filter(
		(sequence) => sequence.length > 0,
	);
	const maxStopSequenceLength = Math.max(
		0,
		...stopSequences.map((sequence) => sequence.length),
	);

	return () => {
		let pendingText = "";
		let pendingTextId: string | undefined;
		let pendingProviderMetadata: ProviderMetadata | undefined;
		let stopped = false;

		const enqueuePending = (
			controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
			text: string,
		) => {
			if (!text || pendingTextId === undefined) {
				return;
			}
			controller.enqueue({
				type: "text-delta",
				id: pendingTextId,
				text,
				...(pendingProviderMetadata
					? { providerMetadata: pendingProviderMetadata }
					: {}),
			} as TextStreamPart<TOOLS>);
		};

		return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
			transform(chunk, controller) {
				if (stopped) {
					if (chunk.type !== "text-delta") {
						controller.enqueue(chunk);
					}
					return;
				}
				if (chunk.type !== "text-delta" || stopSequences.length === 0) {
					if (
						pendingText &&
						(chunk.type === "text-end" ||
							chunk.type === "finish-step" ||
							chunk.type === "finish" ||
							chunk.type === "abort" ||
							chunk.type === "error")
					) {
						enqueuePending(controller, pendingText);
						pendingText = "";
					}
					controller.enqueue(chunk);
					return;
				}

				pendingTextId = chunk.id;
				pendingProviderMetadata = chunk.providerMetadata;
				pendingText += chunk.text;

				let firstMatch: { index: number; sequence: string } | undefined;
				for (const sequence of stopSequences) {
					const index = pendingText.indexOf(sequence);
					if (
						index >= 0 &&
						(firstMatch === undefined || index < firstMatch.index)
					) {
						firstMatch = { index, sequence };
					}
				}

				if (firstMatch) {
					const retainedText = pendingText.slice(
						0,
						firstMatch.index + firstMatch.sequence.length,
					);
					enqueuePending(controller, retainedText);
					pendingText = "";
					stopped = true;
					params.onStop?.(firstMatch.sequence);
					return;
				}

				const retainedSuffixLength = Math.min(
					pendingText.length,
					Math.max(0, maxStopSequenceLength - 1),
				);
				const emitLength = pendingText.length - retainedSuffixLength;
				if (emitLength > 0) {
					enqueuePending(controller, pendingText.slice(0, emitLength));
					pendingText = pendingText.slice(emitLength);
				}
			},
			flush(controller) {
				if (!stopped && pendingText) {
					enqueuePending(controller, pendingText);
				}
			},
		});
	};
}

function toTokenUsage(usage: LanguageModelUsage): TokenUsage {
	const inputTokens =
		typeof usage?.inputTokens === "number"
			? usage.inputTokens
			: typeof (usage as any)?.promptTokens === "number"
				? (usage as any).promptTokens
				: 0;
	const totalOutputTokens =
		typeof usage?.outputTokens === "number"
			? usage.outputTokens
			: typeof (usage as any)?.completionTokens === "number"
				? (usage as any).completionTokens
				: 0;
	const reasoningTokens =
		typeof usage?.outputTokenDetails?.reasoningTokens === "number"
			? usage.outputTokenDetails.reasoningTokens
			: undefined;
	const nonReasoningOutputTokens =
		typeof usage?.outputTokenDetails?.textTokens === "number"
			? usage.outputTokenDetails.textTokens
			: typeof reasoningTokens === "number"
				? Math.max(0, totalOutputTokens - reasoningTokens)
				: undefined;
	const cachedInputTokens =
		typeof usage?.inputTokenDetails?.cacheReadTokens === "number"
			? usage.inputTokenDetails.cacheReadTokens
			: 0;
	const cacheWriteTokens =
		typeof usage?.inputTokenDetails?.cacheWriteTokens === "number"
			? usage.inputTokenDetails.cacheWriteTokens
			: 0;
	const totalTokens =
		typeof usage?.totalTokens === "number"
			? usage.totalTokens
			: inputTokens + totalOutputTokens;

	return {
		input_tokens: inputTokens,
		cached_input_tokens: cachedInputTokens,
		cache_write_tokens: cacheWriteTokens,
		reasoning_tokens: reasoningTokens,
		non_reasoning_output_tokens: nonReasoningOutputTokens,
		output_tokens: totalOutputTokens,
		total_tokens: totalTokens,
	};
}

export function __toTokenUsageForTests(usage: LanguageModelUsage): TokenUsage {
	return toTokenUsage(usage);
}

function buildProviderOptions(params: {
	model: string;
	provider: Provider;
	reasoningEffort: NonNullable<LLMOptions["reasoningEffort"]>;
	openrouterProvider?: string;
	openAIEncryptedResponses?: boolean;
	openAIPromptCache?: OpenAIPromptCacheRequest;
}) {
	if (params.provider === "openai") {
		const uses24HourPromptCacheRetention =
			params.model === "gpt-5.5" || params.model === "gpt-5.5-pro";
		return {
			openai: {
				include_usage: true,
				reasoningSummary: "detailed",
				reasoningEffort: params.reasoningEffort,
				...(params.openAIEncryptedResponses
					? {
							store: false,
						}
					: {}),
				...(params.openAIPromptCache
					? {
							...(params.openAIPromptCache.promptCacheKey
								? {
										promptCacheKey:
											params.openAIPromptCache.promptCacheKey,
									}
								: {}),
							promptCacheOptions:
								params.openAIPromptCache.promptCacheOptions,
							store: false,
						}
					: {}),
				...(uses24HourPromptCacheRetention
					? { promptCacheRetention: "24h" as const }
					: {}),
			},
		};
	}
	if (params.provider === "codex") {
		return {
			openai: {
				include_usage: true,
				reasoningSummary: "detailed",
				reasoningEffort: params.reasoningEffort,
				store: false,
			},
		};
	}

	const capability = getReasoningModelCapability(params.provider, params.model);
	if (params.provider === "vllm") {
		const enabled = params.reasoningEffort === "enabled";
		const reasoningEnabled = params.reasoningEffort !== "none";
		const glmReasoningEnabled =
			capability?.model === "glm" && params.reasoningEffort !== "none";
		const deepSeekV4ReasoningEnabled =
			capability?.model === "deepseek-ai/DeepSeek-V4-Flash-0731" &&
			params.reasoningEffort !== "none";
		return {
			vllm: {
				...(reasoningEnabled &&
				typeof featureFlags.maxThinkingTokenBudget === "number"
					? {
							thinking_token_budget: featureFlags.maxThinkingTokenBudget,
						}
					: {}),
				...(capability?.model === "qwen"
					? {
							chat_template_kwargs: {
								enable_thinking: enabled,
							},
						}
					: glmReasoningEnabled
						? {
								chat_template_kwargs: {
									enable_thinking: true,
									reasoning_effort: params.reasoningEffort,
								},
							}
						: deepSeekV4ReasoningEnabled
							? {
									chat_template_kwargs: {
										thinking: true,
										reasoning_effort: params.reasoningEffort,
									},
								}
							: {
									reasoning: { enabled: false },
									chat_template_kwargs: {
										enable_thinking: false,
										thinking: false,
									},
								}),
			},
		};
	}

	if (params.provider === "together") {
		if (params.reasoningEffort === "none") {
			return {
				together: {
					include_usage: true,
					reasoning: { enabled: false },
					chat_template_kwargs: {
						enable_thinking: false,
						thinking: false,
					},
				},
			};
		}
		return {
			together: {
				include_usage: true,
				reasoningEffort: params.reasoningEffort,
			},
		};
	}

	if (params.provider === "openrouter") {
		return {
			openrouter: {
				reasoning: { effort: params.reasoningEffort },
				...(params.openrouterProvider
					? {
							provider: {
								only: [params.openrouterProvider.trim()],
								allow_fallbacks: false,
							},
						}
					: {}),
			},
		};
	}

	return {
		openai: {
			include_usage: true,
			reasoningSummary: "detailed",
		},
		vllm: {
			chat_template_kwargs: {
				enable_thinking: true,
			},
		},
	};
}

function normalizeOpenRouterResponseMessages(params: {
	responseMessages: ModelMessage[];
	providerMetadata: ProviderMetadata | undefined;
}): ModelMessage[] {
	const openrouter = params.providerMetadata?.openrouter;
	const reasoningDetails =
		openrouter && typeof openrouter === "object"
			? (openrouter as Record<string, unknown>).reasoning_details
			: undefined;
	if (!Array.isArray(reasoningDetails) || reasoningDetails.length === 0) {
		return params.responseMessages;
	}

	const lastAssistantIndex = findLastAssistantMessageIndex(
		params.responseMessages,
	);
	if (lastAssistantIndex < 0) return params.responseMessages;

	return params.responseMessages.map((message, index) => {
		if (index !== lastAssistantIndex || message.role !== "assistant") {
			return message;
		}
		const existingOpenRouter = message.providerOptions?.openrouter;
		return {
			...message,
			providerOptions: {
				...message.providerOptions,
				openrouter: {
					...(existingOpenRouter && typeof existingOpenRouter === "object"
						? existingOpenRouter
						: {}),
					reasoning_details: reasoningDetails,
				},
			},
		};
	});
}

function addOpenAICompatibleThinkFallback(params: {
	responseMessages: ModelMessage[];
	cleanText: string;
	reasoningText: string;
}): ModelMessage[] {
	if (!params.reasoningText) return params.responseMessages;
	const lastAssistantIndex = findLastAssistantMessageIndex(
		params.responseMessages,
	);
	if (lastAssistantIndex < 0) return params.responseMessages;

	return params.responseMessages.map((message, index): ModelMessage => {
		if (index !== lastAssistantIndex || message.role !== "assistant") {
			return message;
		}
		const content: AssistantContentParts =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
		const hasExistingReasoning = content.some(
			(part) => part.type === "reasoning",
		);
		let replacedText = false;
		const rebuiltContent: AssistantContentParts = [];
		for (const part of content) {
			if (part.type !== "text") {
				rebuiltContent.push(part);
				continue;
			}
			if (replacedText) continue;
			replacedText = true;
			if (!hasExistingReasoning) {
				rebuiltContent.push({
					type: "reasoning",
					text: params.reasoningText,
				});
			}
			rebuiltContent.push({ type: "text", text: params.cleanText });
		}
		if (!replacedText) {
			if (!hasExistingReasoning) {
				rebuiltContent.push({
					type: "reasoning",
					text: params.reasoningText,
				});
			}
			rebuiltContent.push({ type: "text", text: params.cleanText });
		}
		return { ...message, content: rebuiltContent } as ModelMessage;
	});
}

function assertOpenAIEncryptedReasoningMetadata(
	responseMessages: ModelMessage[],
): void {
	const reasoningItems = new Map<string, boolean>();
	let reasoningPartCount = 0;
	for (const message of responseMessages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			if (part.type !== "reasoning") continue;
			reasoningPartCount += 1;
			const openai = part.providerOptions?.openai;
			const itemId =
				openai && typeof openai === "object"
					? (openai as Record<string, unknown>).itemId
					: undefined;
			const encryptedContent =
				openai && typeof openai === "object"
					? (openai as Record<string, unknown>).reasoningEncryptedContent
					: undefined;
			const reasoningItemKey =
				typeof itemId === "string" && itemId.length > 0
					? itemId
					: `part:${reasoningPartCount}`;
			reasoningItems.set(
				reasoningItemKey,
				(reasoningItems.get(reasoningItemKey) ?? false) ||
					(typeof encryptedContent === "string" &&
						encryptedContent.length > 0),
			);
		}
	}
	if ([...reasoningItems.values()].some((hasEncrypted) => !hasEncrypted)) {
		throw new Error(
			"OpenAI encrypted response is missing reasoning metadata.",
		);
	}
}

function normalizeProviderResponseMessages(params: {
	provider: Provider;
	runtimeConfig: ProviderRuntimeConfig;
	responseMessages: ModelMessage[];
	providerMetadata: ProviderMetadata | undefined;
	cleanText: string;
	thinkFallback: string;
	requireOpenAIEncryptedReasoning: boolean;
}): ModelMessage[] {
	let responseMessages = params.responseMessages;
	if (params.provider === "openrouter") {
		responseMessages = normalizeOpenRouterResponseMessages({
			responseMessages,
			providerMetadata: params.providerMetadata,
		});
	}
	if (params.runtimeConfig.adapter === "openai-compatible") {
		responseMessages = addOpenAICompatibleThinkFallback({
			responseMessages,
			cleanText: params.cleanText,
			reasoningText: params.thinkFallback,
		});
	}
	if (params.requireOpenAIEncryptedReasoning) {
		assertOpenAIEncryptedReasoningMetadata(responseMessages);
	}
	return responseMessages;
}

async function runProviderChatInternal(
	args: ProviderChatArgs,
): Promise<ProviderChatResult> {
	validateReasoningConfiguration(args.options);
	const runtimeConfig = resolveProviderRuntimeConfig(args.options);
	const model = buildLanguageModel({
		model: args.options.model,
		runtimeConfig,
	});
	const isVLLMProvider = args.options.provider === "vllm";

	const providerOptions = buildProviderOptions({
		model: args.options.model,
		provider: args.options.provider,
		reasoningEffort: args.options.reasoningEffort!,
		openrouterProvider: args.options.openrouterProvider,
		openAIEncryptedResponses: args.openAIEncryptedResponses,
		openAIPromptCache: args.openAIPromptCache,
	});
	const stripThinkFallback =
		runtimeConfig.adapter === "openai-compatible"
			? stripThinkBlocks
			: (text: string) => ({ cleanContent: text, reasoningTokens: "" });
	const requireOpenAIEncryptedReasoning =
		(args.options.provider === "openai" &&
			(args.openAIEncryptedResponses === true ||
				args.openAIPromptCache !== undefined)) ||
		args.options.provider === "codex";

	if (args.onOutputChunk || args.onLifecycleEvent) {
		let firstDeltaEmitted = false;
		let firstTextDeltaEmitted = false;
		let matchedOutputStopSequence: string | undefined;
		let outputStopEventEmitted = false;
		const outputStopSequences = args.outputStopSequences ?? [];
		const streamed = streamText({
			model: model as any,
			messages: args.messages,
			allowSystemInMessages: true,
			abortSignal: args.abortSignal,
			...(args.options.provider === "codex"
				? {}
				: { maxOutputTokens: args.options.reserveOutputTokens }),
			temperature: isVLLMProvider ? 0.2 : undefined,
			...(outputStopSequences.length > 0
				? {
						experimental_transform: createFinalOutputStopTransform({
							stopSequences: outputStopSequences,
							onStop: (sequence) => {
								matchedOutputStopSequence = sequence;
							},
						}),
					}
				: {}),
			onChunk: ({ chunk }) => {
				if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") {
					return;
				}
				if (!firstDeltaEmitted) {
					firstDeltaEmitted = true;
					args.onLifecycleEvent?.({
						type: "first_delta",
						deltaType: chunk.type === "text-delta" ? "text" : "reasoning",
					});
				}
				if (chunk.type === "text-delta" && !firstTextDeltaEmitted) {
					firstTextDeltaEmitted = true;
					args.onLifecycleEvent?.({ type: "first_text_delta" });
				}
				if (
					chunk.type === "text-delta" &&
					matchedOutputStopSequence !== undefined &&
					!outputStopEventEmitted
				) {
					outputStopEventEmitted = true;
					args.onLifecycleEvent?.({
						type: "output_stop_sequence",
						sequence: matchedOutputStopSequence,
					});
				}
			},
			providerOptions: providerOptions as unknown as NonNullable<
				Parameters<typeof streamText>[0]["providerOptions"]
			>,
		});
		const chunks = await collectStreamedText(
			streamed.textStream,
			args.onOutputChunk,
		);
		args.onLifecycleEvent?.({
			type: "text_stream_complete",
			chunkCount: chunks.length,
			outputCharacters: chunks.reduce(
				(total, chunk) => total + chunk.length,
				0,
			),
		});
		const [usage, streamedReasoning, responseMessages, providerMetadata] =
			await Promise.all([
				streamed.usage,
				streamed.reasoning,
				streamed.responseMessages,
				streamed.providerMetadata,
			]);
		args.onLifecycleEvent?.({ type: "usage_complete" });
		const assembledText = chunks.join("");
		const assembledReasoning = normalizeReasoningToString(
			streamedReasoning ?? [],
		);
		logActionBoundary("provider_stream_assembled", {
			provider: args.options.provider,
			model: args.options.model,
			text: assembledText,
			reasoning: assembledReasoning,
		});
		const { cleanContent, reasoningTokens } = stripThinkFallback(assembledText);
		const mergedReasoningTokens = [assembledReasoning, reasoningTokens]
			.filter((value) => value.length > 0)
			.join("\n")
			.trim();
		const normalizedResponseMessages = normalizeProviderResponseMessages({
			provider: args.options.provider,
			runtimeConfig,
			responseMessages,
			providerMetadata,
			cleanText: cleanContent,
			thinkFallback: reasoningTokens,
			requireOpenAIEncryptedReasoning,
		});
		return {
			content: cleanContent || "{}",
			usage: toTokenUsage(usage),
			reasoning_tokens: mergedReasoningTokens,
			responseMessages: normalizedResponseMessages,
		};
	}

	const generated = await generateText({
		model: model as any,
		messages: args.messages,
		allowSystemInMessages: true,
		abortSignal: args.abortSignal,
		...(args.options.provider === "codex"
			? {}
			: { maxOutputTokens: args.options.reserveOutputTokens }),
		temperature: isVLLMProvider ? 0.2 : undefined,
		providerOptions: providerOptions as unknown as NonNullable<
			Parameters<typeof generateText>[0]["providerOptions"]
		>,
	});

	const usage = await generated.usage;
	logActionBoundary("provider_generation_assembled", {
		provider: args.options.provider,
		model: args.options.model,
		text: generated.text,
		reasoning: normalizeReasoningToString(generated.reasoning ?? []),
	});
	const { cleanContent, reasoningTokens } = stripThinkFallback(generated.text);
	const mergedReasoningTokens = [
		normalizeReasoningToString(generated.reasoning ?? []),
		reasoningTokens,
	]
		.filter((value) => value.length > 0)
		.join("\n")
		.trim();
	const normalizedResponseMessages = normalizeProviderResponseMessages({
		provider: args.options.provider,
		runtimeConfig,
		responseMessages: generated.responseMessages,
		providerMetadata: generated.providerMetadata,
		cleanText: cleanContent,
		thinkFallback: reasoningTokens,
		requireOpenAIEncryptedReasoning,
	});
	return {
		content: cleanContent || "{}",
		usage: toTokenUsage(usage),
		reasoning_tokens: mergedReasoningTokens,
		responseMessages: normalizedResponseMessages,
	};
}

export function __setProviderChatOverrideForTests(
	override: ((args: ProviderChatArgs) => Promise<ProviderChatResult>) | null,
): void {
	providerChatOverride = override;
}

export function __setProviderOverrideForTests(
	provider: Provider,
	override: ((args: ProviderChatArgs) => Promise<ProviderChatResult>) | null,
): void {
	perProviderOverrides.set(provider, override);
}

export function __buildProviderOptionsForTests(params: {
	model: string;
	provider: Provider;
	reasoningEffort: NonNullable<LLMOptions["reasoningEffort"]>;
	openrouterProvider?: string;
	openAIEncryptedResponses?: boolean;
	openAIPromptCache?: OpenAIPromptCacheRequest;
}) {
	validateReasoningConfiguration({
		provider: params.provider,
		model: params.model,
		reasoningEffort: params.reasoningEffort,
	});
	return buildProviderOptions(params);
}

export function __buildOpenRouterModelSettingsForTests() {
	return buildOpenRouterModelSettings();
}

export function __normalizeOpenRouterResponseMessagesForTests(params: {
	responseMessages: ModelMessage[];
	providerMetadata: ProviderMetadata | undefined;
}): ModelMessage[] {
	return normalizeOpenRouterResponseMessages(params);
}

export function __addOpenAICompatibleThinkFallbackForTests(params: {
	responseMessages: ModelMessage[];
	cleanText: string;
	reasoningText: string;
}): ModelMessage[] {
	return addOpenAICompatibleThinkFallback(params);
}

export function __assertOpenAIEncryptedReasoningMetadataForTests(
	responseMessages: ModelMessage[],
): void {
	assertOpenAIEncryptedReasoningMetadata(responseMessages);
}

export async function __collectStreamedTextForTests(
	textStream: AsyncIterable<string>,
	onOutputChunk?: (chunk: string) => void,
): Promise<string[]> {
	return await collectStreamedText(textStream, onOutputChunk);
}

export function __createFinalOutputStopTransformForTests<
	TOOLS extends ToolSet,
>(params: {
	stopSequences: readonly string[];
	onStop?: (sequence: string) => void;
}): StreamTextTransform<TOOLS> {
	return createFinalOutputStopTransform(params);
}

export async function runProviderChat(
	args: ProviderChatArgs,
): Promise<ProviderChatResult> {
	const providerOverride = perProviderOverrides.get(args.options.provider);
	if (providerOverride) {
		return await providerOverride(args);
	}
	if (providerChatOverride) {
		return await providerChatOverride(args);
	}
	return await runProviderChatInternal(args);
}
