import { assert } from "chai";
import { describe, it } from "mocha";
import type { ModelMessage, ProviderMetadata } from "ai";
import { featureFlags } from "../src/featureFlags.js";
import {
	__addOpenAICompatibleThinkFallbackForTests,
	__assertOpenAIEncryptedReasoningMetadataForTests,
	__buildOpenRouterModelSettingsForTests,
	__buildProviderOptionsForTests,
	__normalizeOpenRouterResponseMessagesForTests,
	__toTokenUsageForTests,
} from "../src/agents/providers/ai-sdk.js";

describe("provider options", () => {
	it("uses non-stored Responses reasoning options for Codex", () => {
		const options = __buildProviderOptionsForTests({
			model: "gpt-5.6-luna",
			provider: "codex",
			reasoningEffort: "high",
			openAIPromptCache: {
				promptCacheKey: "must-not-be-sent",
				promptCacheOptions: { mode: "explicit", ttl: "30m" },
			},
		});

		assert.deepEqual(options.openai, {
			include_usage: true,
			reasoningSummary: "detailed",
			reasoningEffort: "high",
			store: false,
		});
		assert.notProperty(options.openai, "promptCacheKey");
		assert.notProperty(options.openai, "promptCacheOptions");
	});

	it("requests encrypted OpenAI responses without flattening instructions", () => {
		const options = __buildProviderOptionsForTests({
			model: "gpt-5.6-terra",
			provider: "openai",
			reasoningEffort: "medium",
			openAIEncryptedResponses: true,
		});

		assert.deepInclude(options.openai, {
			store: false,
			reasoningSummary: "detailed",
			reasoningEffort: "medium",
		});
		assert.notProperty(options.openai, "instructions");
	});

	it("does not disable storage without encrypted responses or explicit cache", () => {
		const options = __buildProviderOptionsForTests({
			model: "gpt-5.6-terra",
			provider: "openai",
			reasoningEffort: "medium",
		});

		assert.notProperty(options.openai, "store");
	});

	it("forwards explicit OpenAI cache options", () => {
		const options = __buildProviderOptionsForTests({
			model: "gpt-5.6-luna",
			provider: "openai",
			reasoningEffort: "none",
			openAIPromptCache: {
				promptCacheKey: "stable-worker-key",
				promptCacheOptions: { mode: "explicit", ttl: "30m" },
			},
		});

		assert.deepInclude(options.openai, {
			promptCacheKey: "stable-worker-key",
			promptCacheOptions: { mode: "explicit", ttl: "30m" },
			store: false,
		});
	});

	it("passes OpenRouter reasoning and provider settings", () => {
		const options = __buildProviderOptionsForTests({
			model: "z-ai/glm-5.2",
			provider: "openrouter",
			reasoningEffort: "xhigh",
			openrouterProvider: " baseten/fp8 ",
		});

		assert.deepEqual(options.openrouter, {
			reasoning: { effort: "xhigh" },
			provider: {
				only: ["baseten/fp8"],
				allow_fallbacks: false,
			},
		});
		assert.deepEqual(__buildOpenRouterModelSettingsForTests(), {
			usage: { include: true },
		});
	});

	it("configures Together and vLLM reasoning natively", () => {
		const together = __buildProviderOptionsForTests({
			model: "zai-org/GLM-5.2",
			provider: "together",
			reasoningEffort: "max",
		});
		assert.deepEqual(together.together, {
			include_usage: true,
			reasoningEffort: "max",
		});

		const originalBudget = featureFlags.maxThinkingTokenBudget;
		try {
			featureFlags.maxThinkingTokenBudget = 4096;
			const vllm = __buildProviderOptionsForTests({
				model: "deepseek-ai/DeepSeek-V4-Flash-0731",
				provider: "vllm",
				reasoningEffort: "high",
			});
			assert.deepEqual(vllm.vllm, {
				thinking_token_budget: 4096,
				chat_template_kwargs: {
					thinking: true,
					reasoning_effort: "high",
				},
			});
		} finally {
			featureFlags.maxThinkingTokenBudget = originalBudget;
		}
	});

	it("forwards Qwen3.8 reasoning effort to vLLM and its chat template", () => {
		for (const reasoningEffort of ["low", "medium", "xhigh"] as const) {
			const options = __buildProviderOptionsForTests({
				model: "Qwen/Qwen3.8-27B",
				provider: "vllm",
				reasoningEffort,
			});

			assert.deepEqual(options.vllm, {
				reasoning_effort: reasoningEffort,
				chat_template_kwargs: {
					enable_thinking: true,
					reasoning_effort: reasoningEffort,
				},
			});
		}

		const disabled = __buildProviderOptionsForTests({
			model: "Qwen/Qwen3.8-27B",
			provider: "vllm",
			reasoningEffort: "none",
		});
		assert.deepEqual(disabled.vllm, {
			reasoning_effort: "none",
			chat_template_kwargs: {
				enable_thinking: false,
				reasoning_effort: "none",
			},
		});
	});

});

describe("provider response messages", () => {
	it("preserves full OpenRouter reasoning_details on the assistant message", () => {
		const responseMessages: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "summary" },
					{ type: "text", text: "answer" },
				],
			},
		];
		const reasoningDetails = [
			{ type: "reasoning.encrypted", data: "signed-payload", id: "r1" },
		];
		const result = __normalizeOpenRouterResponseMessagesForTests({
			responseMessages,
			providerMetadata: {
				openrouter: { reasoning_details: reasoningDetails },
			} as ProviderMetadata,
		});

		assert.deepEqual(result, [
			{
				...responseMessages[0],
				providerOptions: {
					openrouter: { reasoning_details: reasoningDetails },
				},
			},
		]);
	});

	it("turns openai-compatible think text into a native reasoning part", () => {
		const result = __addOpenAICompatibleThinkFallbackForTests({
			responseMessages: [
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "<think>hidden</think>answer",
							providerOptions: { vllm: { source: "raw" } },
						},
					],
				},
			],
			cleanText: "answer",
			reasoningText: "hidden",
		});

		assert.deepEqual(result, [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "hidden" },
					{ type: "text", text: "answer" },
				],
			},
		]);
	});

	it("does not duplicate native reasoning when a think tag is also present", () => {
		const existingReasoning = {
			type: "reasoning" as const,
			text: "native",
			providerOptions: { together: { signature: "preserved" } },
		};
		const result = __addOpenAICompatibleThinkFallbackForTests({
			responseMessages: [
				{
					role: "assistant",
					content: [
						existingReasoning,
						{ type: "text", text: "<think>duplicate</think>answer" },
					],
				},
			],
			cleanText: "answer",
			reasoningText: "duplicate",
		});

		assert.deepEqual(result, [
			{
				role: "assistant",
				content: [existingReasoning, { type: "text", text: "answer" }],
			},
		]);
	});

	it("accepts ciphertext on a later summary part of the same OpenAI item", () => {
		assert.doesNotThrow(() =>
			__assertOpenAIEncryptedReasoningMetadataForTests([
				{
					role: "assistant",
					content: [
						{
							type: "reasoning",
							text: "first summary",
							providerOptions: { openai: { itemId: "reasoning-1" } },
						},
						{
							type: "reasoning",
							text: "second summary",
							providerOptions: {
								openai: {
									itemId: "reasoning-1",
									reasoningEncryptedContent: "ciphertext",
								},
							},
						},
					],
				},
			]),
		);
	});

	it("rejects a distinct OpenAI reasoning item without ciphertext", () => {
		assert.throws(
			() =>
				__assertOpenAIEncryptedReasoningMetadataForTests([
					{
						role: "assistant",
						content: [
							{
								type: "reasoning",
								text: "complete",
								providerOptions: {
									openai: {
										itemId: "reasoning-1",
										reasoningEncryptedContent: "ciphertext",
									},
								},
							},
							{
								type: "reasoning",
								text: "incomplete",
								providerOptions: { openai: { itemId: "reasoning-2" } },
							},
						],
					},
				]),
			"missing reasoning metadata",
		);
	});
});

describe("provider token usage", () => {
	it("splits reasoning from non-reasoning output tokens", () => {
		assert.deepEqual(
			__toTokenUsageForTests({
				inputTokens: 20,
				inputTokenDetails: {
					noCacheTokens: 13,
					cacheReadTokens: 5,
					cacheWriteTokens: 2,
				},
				outputTokens: 10,
				outputTokenDetails: { textTokens: 7, reasoningTokens: 3 },
				totalTokens: 30,
				raw: undefined,
			}),
			{
				input_tokens: 20,
				cached_input_tokens: 5,
				cache_write_tokens: 2,
				reasoning_tokens: 3,
				non_reasoning_output_tokens: 7,
				output_tokens: 10,
				total_tokens: 30,
			},
		);
	});
});
