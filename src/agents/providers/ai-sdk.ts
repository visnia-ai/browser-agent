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
import OpenAI from "openai";
import type {
	LLMOptions,
	OpenAIEncryptedContinuationInput,
	OpenAIEncryptedContinuationOutput,
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

export const SUPPORTED_MODEL_PROVIDERS = [
	{
		id: "openai",
		adapter: "openai",
		requiresApiKey: true,
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

function buildOpenRouterModelSettings() {
	return { usage: { include: true } } as const;
}

export interface ProviderChatArgs {
	options: LLMOptions;
	prompt: string;
	instructions?: string;
	providerContinuation?: OpenAIEncryptedContinuationInput;
	/** Fully reconstructed native input used by current-mode encrypted replay. */
	openAIInputMessages?: ModelMessage[];
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
	providerContinuation?: OpenAIEncryptedContinuationOutput;
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

export class OpenAIEncryptedContinuationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpenAIEncryptedContinuationError";
	}
}

let openaiClient: OpenAI | null = null;
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
	const apiKey = resolveApiKey(options);
	const endpointUrl = resolveEndpointUrl(options);

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

function buildLanguageModel(options: {
	model: string;
	runtimeConfig: ProviderRuntimeConfig;
}) {
	if (options.runtimeConfig.adapter === "openrouter") {
		return createOpenRouter({
			apiKey: options.runtimeConfig.apiKey!,
			baseURL: options.runtimeConfig.endpointUrl,
			compatibility: "strict",
		})(options.model, buildOpenRouterModelSettings());
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
	instructions?: string;
	providerContinuation?: OpenAIEncryptedContinuationInput;
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
				...(params.instructions !== undefined
					? { instructions: params.instructions }
					: {}),
				...(params.providerContinuation
					? {
							store: false,
							include: ["reasoning.encrypted_content"] as const,
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

function buildOpenAIContinuationMessages(
	continuation: OpenAIEncryptedContinuationInput,
	prompt: string,
): ModelMessage[] {
	if (continuation.strategy !== "cumulative") {
		throw new Error(
			"Current-mode OpenAI replay requires reconstructed input messages.",
		);
	}
	return [...continuation.messages, { role: "user", content: prompt }];
}

function buildOpenAIContinuationOutput(params: {
	continuation: OpenAIEncryptedContinuationInput;
	prompt: string;
	responseMessages: ModelMessage[];
}): OpenAIEncryptedContinuationOutput {
	const reasoningItems = new Map<string, boolean>();
	let reasoningPartCount = 0;
	for (const message of params.responseMessages) {
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
			const hasEncryptedContent =
				typeof encryptedContent === "string" && encryptedContent.length > 0;
			const reasoningItemKey =
				typeof itemId === "string" && itemId.length > 0
					? itemId
					: `part:${reasoningPartCount}`;
			reasoningItems.set(
				reasoningItemKey,
				(reasoningItems.get(reasoningItemKey) ?? false) || hasEncryptedContent,
			);
		}
	}
	if (
		[...reasoningItems.values()].some(
			(hasEncryptedContent) => !hasEncryptedContent,
		)
	) {
		throw new OpenAIEncryptedContinuationError(
			"OpenAI encrypted continuation is missing reasoning metadata.",
		);
	}
	if (params.continuation.strategy === "current") {
		const reasoningMessages = params.responseMessages.flatMap((message) => {
			if (message.role !== "assistant" || !Array.isArray(message.content)) {
				return [];
			}
			const reasoningParts = message.content.filter(
				(part) => part.type === "reasoning",
			);
			return reasoningParts.length > 0
				? [{ ...message, content: reasoningParts } as ModelMessage]
				: [];
		});
		return {
			provider: "openai",
			strategy: "current",
			reasoningMessages,
		};
	}
	return {
		provider: "openai",
		strategy: "cumulative",
		messages: [
			...buildOpenAIContinuationMessages(params.continuation, params.prompt),
			...params.responseMessages,
		],
	};
}

export function __buildOpenAIContinuationOutputForTests(params: {
	continuation: OpenAIEncryptedContinuationInput;
	prompt: string;
	responseMessages: ModelMessage[];
}): OpenAIEncryptedContinuationOutput {
	return buildOpenAIContinuationOutput(params);
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
		instructions: args.instructions,
		providerContinuation: args.providerContinuation,
		openAIPromptCache: args.openAIPromptCache,
	});

	if (args.onOutputChunk || args.onLifecycleEvent) {
		let firstDeltaEmitted = false;
		let firstTextDeltaEmitted = false;
		let matchedOutputStopSequence: string | undefined;
		let outputStopEventEmitted = false;
		const outputStopSequences = args.outputStopSequences ?? [];
		const streamed = streamText({
			model: model as any,
			...(args.openAIInputMessages
				? { messages: args.openAIInputMessages }
				: args.providerContinuation
					? {
							messages: buildOpenAIContinuationMessages(
								args.providerContinuation,
								args.prompt,
							),
						}
					: { prompt: args.prompt }),
			allowSystemInMessages: Boolean(
				args.openAIInputMessages?.some((message) => message.role === "system"),
			),
			abortSignal: args.abortSignal,
			maxOutputTokens: args.options.reserveOutputTokens,
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
		const [usage, streamedReasoning, response] = await Promise.all([
			streamed.usage,
			streamed.reasoning,
			streamed.response,
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
		const { cleanContent, reasoningTokens } = stripThinkBlocks(assembledText);
		const mergedReasoningTokens = [assembledReasoning, reasoningTokens]
			.filter((value) => value.length > 0)
			.join("\n")
			.trim();
		const providerContinuation = args.providerContinuation
			? buildOpenAIContinuationOutput({
					continuation: args.providerContinuation,
					prompt: args.prompt,
					responseMessages: response.messages,
				})
			: undefined;
		return {
			content: cleanContent || "{}",
			usage: toTokenUsage(usage),
			reasoning_tokens: mergedReasoningTokens,
			...(providerContinuation ? { providerContinuation } : {}),
		};
	}

	const generated = await generateText({
		model: model as any,
		...(args.openAIInputMessages
			? { messages: args.openAIInputMessages }
			: args.providerContinuation
				? {
						messages: buildOpenAIContinuationMessages(
							args.providerContinuation,
							args.prompt,
						),
					}
				: { prompt: args.prompt }),
		allowSystemInMessages: Boolean(
			args.openAIInputMessages?.some((message) => message.role === "system"),
		),
		abortSignal: args.abortSignal,
		maxOutputTokens: args.options.reserveOutputTokens,
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
	const { cleanContent, reasoningTokens } = stripThinkBlocks(generated.text);
	const mergedReasoningTokens = [
		normalizeReasoningToString(generated.reasoning ?? []),
		reasoningTokens,
	]
		.filter((value) => value.length > 0)
		.join("\n")
		.trim();
	const providerContinuation = args.providerContinuation
		? buildOpenAIContinuationOutput({
				continuation: args.providerContinuation,
				prompt: args.prompt,
				responseMessages: generated.response.messages,
			})
		: undefined;
	return {
		content: cleanContent || "{}",
		usage: toTokenUsage(usage),
		reasoning_tokens: mergedReasoningTokens,
		...(providerContinuation ? { providerContinuation } : {}),
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
	instructions?: string;
	providerContinuation?: OpenAIEncryptedContinuationInput;
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

function getOpenAIClient(): OpenAI {
	if (openaiClient) {
		return openaiClient;
	}
	const apiKey = readEnvString("OPENAI_API_KEY");
	if (!apiKey) {
		throw new Error(
			"Missing OPENAI_API_KEY for token counting. Set OPENAI_API_KEY in the environment.",
		);
	}
	openaiClient = new OpenAI({ apiKey });
	return openaiClient;
}

export function __setOpenAIClientForTests(client: OpenAI | null): void {
	openaiClient = client;
}

export async function countInputTokensOpenAI(input: {
	model: string;
	payload: unknown;
}): Promise<number> {
	const res = await getOpenAIClient().responses.inputTokens.count({
		model: input.model,
		input: input.payload as any,
	});
	return res.input_tokens ?? 0;
}
