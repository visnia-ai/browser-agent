import { assert } from "chai";
import { describe, it } from "mocha";
import { featureFlags } from "../src/featureFlags.js";
import {
	__buildOpenRouterModelSettingsForTests,
	__buildOpenAIContinuationOutputForTests,
	__buildProviderOptionsForTests,
	__toTokenUsageForTests,
} from "../src/agents/providers/ai-sdk.js";

describe("provider options", () => {
	it("passes the exact OpenAI reasoning effort", () => {
		const options = __buildProviderOptionsForTests({
			model: "gpt-5.5",
			provider: "openai",
			reasoningEffort: "medium",
		});

		assert.deepEqual(options.openai, {
			include_usage: true,
			reasoningSummary: "detailed",
			reasoningEffort: "medium",
			promptCacheRetention: "24h",
		});
	});

	it("does not send legacy prompt cache retention to GPT-5.6", () => {
		const options = __buildProviderOptionsForTests({
			model: "gpt-5.6-terra",
			provider: "openai",
			reasoningEffort: "medium",
		});

		assert.deepEqual(options.openai, {
			include_usage: true,
			reasoningSummary: "detailed",
			reasoningEffort: "medium",
		});
	});

	it("forwards OpenAI continuation options and current instructions", () => {
		const options = __buildProviderOptionsForTests({
			model: "gpt-5.6-terra",
			provider: "openai",
			reasoningEffort: "medium",
			instructions: "CURRENT SYSTEM",
			providerContinuation: {
				provider: "openai",
				strategy: "cumulative",
				promptCacheKey: "trajectory-key",
				messages: [],
				inputMode: "incremental",
			},
		});

		assert.deepInclude(options.openai, {
			instructions: "CURRENT SYSTEM",
			promptCacheKey: "trajectory-key",
			store: false,
			include: ["reasoning.encrypted_content"],
		});
		assert.notProperty(options.openai, "previousResponseId");
	});

	it("preserves encrypted reasoning and phase metadata in continuation messages", () => {
		const responseMessages = [
			{
				role: "assistant" as const,
				content: [
					{
						type: "reasoning" as const,
						text: "summary",
						providerOptions: {
							openai: {
								itemId: "reasoning-1",
								reasoningEncryptedContent: "ciphertext",
							},
						},
					},
					{
						type: "text" as const,
						text: "answer",
						providerOptions: {
							openai: {
								itemId: "message-1",
								phase: "final_answer",
							},
						},
					},
				],
			},
		];
		const result = __buildOpenAIContinuationOutputForTests({
			continuation: {
				provider: "openai",
				strategy: "cumulative",
				promptCacheKey: "trajectory-key",
				messages: [{ role: "user", content: "first" }],
				inputMode: "incremental",
			},
			prompt: "second",
			responseMessages,
		});

		assert.deepEqual(result.messages, [
			{ role: "user", content: "first" },
			{ role: "user", content: "second" },
			...responseMessages,
		]);
	});

	it("returns only encrypted reasoning state for current-mode replay", () => {
		const reasoningPart = {
			type: "reasoning" as const,
			text: "summary",
			providerOptions: {
				openai: {
					itemId: "reasoning-current",
					reasoningEncryptedContent: "current-ciphertext",
				},
			},
		};
		const result = __buildOpenAIContinuationOutputForTests({
			continuation: {
				provider: "openai",
				strategy: "current",
				promptCacheKey: "trajectory-key",
				reasoningStateByStep: [],
			},
			prompt: "ignored for reconstructed input",
			responseMessages: [
				{
					role: "assistant",
					content: [reasoningPart, { type: "text", text: "answer" }],
				},
			],
		});

		assert.deepEqual(result, {
			provider: "openai",
			strategy: "current",
			reasoningMessages: [{ role: "assistant", content: [reasoningPart] }],
		});
		assert.notInclude(JSON.stringify(result), "answer");
	});

	it("accepts encrypted metadata on a later summary part of the same reasoning item", () => {
		const responseMessages = [
			{
				role: "assistant" as const,
				content: [
					{
						type: "reasoning" as const,
						text: "first summary",
						providerOptions: {
							openai: { itemId: "reasoning-1" },
						},
					},
					{
						type: "reasoning" as const,
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
		];
		const result = __buildOpenAIContinuationOutputForTests({
			continuation: {
				provider: "openai",
				strategy: "cumulative",
				promptCacheKey: "trajectory-key",
				messages: [],
				inputMode: "incremental",
			},
			prompt: "prompt",
			responseMessages,
		});

		assert.deepEqual(result.messages, [
			{ role: "user", content: "prompt" },
			...responseMessages,
		]);
	});

	it("accepts a response with no reasoning item", () => {
		const responseMessages = [
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "answer" }],
			},
		];
		const result = __buildOpenAIContinuationOutputForTests({
			continuation: {
				provider: "openai",
				strategy: "cumulative",
				promptCacheKey: "trajectory-key",
				messages: [],
				inputMode: "incremental",
			},
			prompt: "prompt",
			responseMessages,
		});

		assert.deepEqual(result.messages, [
			{ role: "user", content: "prompt" },
			...responseMessages,
		]);
	});

	it("fails when reasoning continuation metadata is missing", () => {
		assert.throws(
			() =>
				__buildOpenAIContinuationOutputForTests({
					continuation: {
						provider: "openai",
						strategy: "cumulative",
						promptCacheKey: "trajectory-key",
						messages: [],
						inputMode: "full",
					},
					prompt: "prompt",
					responseMessages: [
						{
							role: "assistant",
							content: [{ type: "reasoning", text: "summary" }],
						},
					],
				}),
			"missing reasoning metadata",
		);
	});

	it("fails when one of multiple reasoning items lacks encrypted metadata", () => {
		assert.throws(
			() =>
				__buildOpenAIContinuationOutputForTests({
					continuation: {
						provider: "openai",
						strategy: "cumulative",
						promptCacheKey: "trajectory-key",
						messages: [],
						inputMode: "full",
					},
					prompt: "prompt",
					responseMessages: [
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
									providerOptions: {
										openai: { itemId: "reasoning-2" },
									},
								},
							],
						},
					],
				}),
			"missing reasoning metadata",
		);
	});

	it("sends Together reasoning disable options for none", () => {
		const disabled = __buildProviderOptionsForTests({
			model: "zai-org/GLM-5.2",
			provider: "together",
			reasoningEffort: "none",
		});

		assert.deepEqual(disabled.together, {
			include_usage: true,
			reasoning: { enabled: false },
			chat_template_kwargs: {
				enable_thinking: false,
				thinking: false,
			},
		});
	});

	it("sets Together GLM-5.2 reasoning effort exactly", () => {
		const enabled = __buildProviderOptionsForTests({
			model: "zai-org/GLM-5.2",
			provider: "together",
			reasoningEffort: "max",
		});

		assert.deepEqual(enabled.together, {
			include_usage: true,
			reasoningEffort: "max",
		});
	});

	it("sets Together DeepSeek V4 low reasoning effort exactly", () => {
		const enabled = __buildProviderOptionsForTests({
			model: "deepseek-ai/DeepSeek-V4-Flash-0731",
			provider: "together",
			reasoningEffort: "low",
		});

		assert.deepEqual(enabled.together, {
			include_usage: true,
			reasoningEffort: "low",
		});
	});

	it("passes OpenRouter reasoning effort exactly", () => {
		const options = __buildProviderOptionsForTests({
			model: "anthropic/claude-sonnet-4",
			provider: "openrouter",
			reasoningEffort: "xhigh",
		});

		assert.deepEqual(options.openrouter, {
			reasoning: { effort: "xhigh" },
		});
		assert.deepEqual(__buildOpenRouterModelSettingsForTests(), {
			usage: { include: true },
		});
	});

	it("pins OpenRouter requests to one provider without fallbacks", () => {
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
	});

	it("maps vLLM Qwen efforts to enable_thinking", () => {
		const disabled = __buildProviderOptionsForTests({
			model: "Qwen/Qwen3.5-397B-A17B-FP8",
			provider: "vllm",
			reasoningEffort: "none",
		});
		const enabled = __buildProviderOptionsForTests({
			model: "qwen3.5-4b-sft",
			provider: "vllm",
			reasoningEffort: "enabled",
		});

		assert.equal(disabled.vllm?.chat_template_kwargs.enable_thinking, false);
		assert.equal(enabled.vllm?.chat_template_kwargs.enable_thinking, true);
		assert.notProperty(disabled.vllm, "thinking_token_budget");
		assert.equal(enabled.vllm?.thinking_token_budget, 8192);
	});

	it("disables reasoning for vLLM GLM", () => {
		const options = __buildProviderOptionsForTests({
			model: "lukealonso/GLM-5.1-NVFP4",
			provider: "vllm",
			reasoningEffort: "none",
		});
		assert.deepEqual(options.vllm, {
			reasoning: { enabled: false },
			chat_template_kwargs: {
				enable_thinking: false,
				thinking: false,
			},
		});
	});

	it("sets vLLM GLM reasoning effort in chat template arguments", () => {
		for (const reasoningEffort of ["high", "max"] as const) {
			const options = __buildProviderOptionsForTests({
				model: "nvidia/GLM-5.2-NVFP4",
				provider: "vllm",
				reasoningEffort,
			});
			assert.deepEqual(options.vllm, {
				thinking_token_budget: 8192,
				chat_template_kwargs: {
					enable_thinking: true,
					reasoning_effort: reasoningEffort,
				},
			});
		}
	});

	it("sets vLLM DeepSeek V4 reasoning effort in chat template arguments", () => {
		for (const reasoningEffort of ["low", "high", "max"] as const) {
			const options = __buildProviderOptionsForTests({
				model: "deepseek-ai/DeepSeek-V4-Flash-0731",
				provider: "vllm",
				reasoningEffort,
			});
			assert.deepEqual(options.vllm, {
				thinking_token_budget: 8192,
				chat_template_kwargs: {
					thinking: true,
					reasoning_effort: reasoningEffort,
				},
			});
		}

		const disabled = __buildProviderOptionsForTests({
			model: "deepseek-ai/DeepSeek-V4-Flash-0731",
			provider: "vllm",
			reasoningEffort: "none",
		});
		assert.deepEqual(disabled.vllm, {
			reasoning: { enabled: false },
			chat_template_kwargs: {
				enable_thinking: false,
				thinking: false,
			},
		});
	});

	it("uses the configured vLLM thinking token budget", () => {
		const originalBudget = featureFlags.maxThinkingTokenBudget;
		try {
			featureFlags.maxThinkingTokenBudget = 4096;
			const options = __buildProviderOptionsForTests({
				model: "deepseek-ai/DeepSeek-V4-Flash-0731",
				provider: "vllm",
				reasoningEffort: "high",
			});

			assert.equal(options.vllm?.thinking_token_budget, 4096);
		} finally {
			featureFlags.maxThinkingTokenBudget = originalBudget;
		}
	});
});

describe("provider token usage", () => {
	it("splits reasoning from non-reasoning output tokens", () => {
		assert.deepEqual(
			__toTokenUsageForTests({
				inputTokens: 20,
				inputTokenDetails: {
					noCacheTokens: 15,
					cacheReadTokens: 5,
					cacheWriteTokens: undefined,
				},
				outputTokens: 10,
				outputTokenDetails: {
					textTokens: 7,
					reasoningTokens: 3,
				},
				totalTokens: 30,
				raw: undefined,
			}),
			{
				input_tokens: 20,
				cached_input_tokens: 5,
				reasoning_tokens: 3,
				non_reasoning_output_tokens: 7,
				output_tokens: 10,
				total_tokens: 30,
			},
		);
	});

	it("preserves an unavailable reasoning split", () => {
		assert.deepEqual(
			__toTokenUsageForTests({
				inputTokens: 20,
				inputTokenDetails: {
					noCacheTokens: 20,
					cacheReadTokens: undefined,
					cacheWriteTokens: undefined,
				},
				outputTokens: 10,
				outputTokenDetails: {
					textTokens: undefined,
					reasoningTokens: undefined,
				},
				totalTokens: 30,
				raw: undefined,
			}),
			{
				input_tokens: 20,
				cached_input_tokens: 0,
				reasoning_tokens: undefined,
				non_reasoning_output_tokens: undefined,
				output_tokens: 10,
				total_tokens: 30,
			},
		);
	});
});
