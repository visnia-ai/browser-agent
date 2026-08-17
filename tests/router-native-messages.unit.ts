import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import type { ModelMessage } from "ai";
import {
	__setProviderOverrideForTests,
	type ProviderChatArgs,
} from "../src/agents/providers/ai-sdk.js";
import { chatYAML } from "../src/agents/providers/router.js";
import type { Provider } from "../src/agents/types.js";

const usage = {
	input_tokens: 10,
	output_tokens: 2,
	total_tokens: 12,
};

const options = {
	provider: "openai" as const,
	model: "gpt-5.6-terra",
	reasoningEffort: "medium" as const,
};

const providerCases: Array<{ provider: Provider; model: string }> = [
	{ provider: "openai", model: "gpt-5.6-terra" },
	{ provider: "codex", model: "gpt-5.6-luna" },
	{ provider: "vllm", model: "Qwen/Qwen3.5-397B-A17B-FP8" },
	{ provider: "anthropic", model: "claude-sonnet-4" },
	{ provider: "google", model: "gemini-3-pro" },
	{ provider: "together", model: "zai-org/GLM-5.2" },
	{ provider: "openrouter", model: "anthropic/claude-sonnet-4" },
];

describe("native message routing", () => {
	afterEach(() => {
		for (const { provider } of providerCases) {
			__setProviderOverrideForTests(provider, null);
		}
	});

	it("preserves structured native messages for every supported provider", async () => {
		const messages: ModelMessage[] = [
			{
				role: "system",
				content: "SYSTEM",
				providerOptions: {
					openai: { promptCacheBreakpoint: { mode: "explicit" } },
				},
			},
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Inspect the image.",
						providerOptions: {
							anthropic: { cacheControl: { type: "ephemeral" } },
						},
					},
					{
						type: "file",
						mediaType: "image/png",
						data: "aW1hZ2UtYnl0ZXM=",
						providerOptions: { openai: { imageDetail: "low" } },
					},
				],
				providerOptions: { google: { cacheKey: "user-message" } },
			},
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "Prior reasoning",
						providerOptions: {
							openrouter: {
								reasoning_details: [
									{ type: "reasoning.encrypted", data: "signed" },
								],
							},
						},
					},
					{ type: "text", text: "Prior answer" },
				],
			},
			{ role: "user", content: "Current step" },
		];

		for (const providerCase of providerCases) {
			let request: ProviderChatArgs | undefined;
			const responseMessages: ModelMessage[] = [
				{
					role: "assistant",
					content: `provider: ${providerCase.provider}`,
				},
			];
			__setProviderOverrideForTests(providerCase.provider, async (args) => {
				request = args;
				return {
					content: `provider: ${providerCase.provider}`,
					usage,
					reasoning_tokens: "",
					responseMessages,
				};
			});

			const result = await chatYAML<{ provider: string }>(
				messages,
				{
					provider: providerCase.provider,
					model: providerCase.model,
				},
				`native-${providerCase.provider}-test`,
			);

			assert.strictEqual(request?.messages, messages);
			assert.deepEqual(request?.messages, messages);
			assert.strictEqual(result.responseMessages, responseMessages);
			assert.deepEqual(result.data, { provider: providerCase.provider });
			__setProviderOverrideForTests(providerCase.provider, null);
		}
	});

	it("sends the complete native message trajectory unchanged", async () => {
		const reasoningPart = {
			type: "reasoning" as const,
			text: "summary",
			providerOptions: {
				openai: {
					itemId: "reasoning-1",
					reasoningEncryptedContent: "ciphertext",
				},
			},
		};
		const messages: ModelMessage[] = [
			{ role: "system", content: "CURRENT SYSTEM" },
			{ role: "user", content: "old payload" },
			{
				role: "assistant",
				content: [reasoningPart, { type: "text", text: "old answer" }],
			},
			{ role: "user", content: "current payload" },
		];
		const responseMessages: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "next summary" },
					{ type: "text", text: "value: ok" },
				],
			},
		];
		let request: ProviderChatArgs | undefined;
		__setProviderOverrideForTests("openai", async (args) => {
			request = args;
			return {
				content: "value: ok",
				usage,
				reasoning_tokens: "next summary",
				responseMessages,
			};
		});

		const result = await chatYAML<{ value: string }>(
			messages,
			options,
			"native-messages-test",
			undefined,
			undefined,
			undefined,
			true,
			{
				promptCacheKey: "stable-worker-key",
				promptCacheOptions: { mode: "explicit", ttl: "30m" },
			},
		);

		assert.strictEqual(request?.messages, messages);
		assert.deepEqual(request?.messages, messages);
		assert.isTrue(request?.openAIEncryptedResponses);
		assert.deepEqual(request?.openAIPromptCache, {
			promptCacheKey: "stable-worker-key",
			promptCacheOptions: { mode: "explicit", ttl: "30m" },
		});
		assert.strictEqual(result.responseMessages, responseMessages);
		assert.deepEqual(result.data, { value: "ok" });
	});

	it("returns response messages only from the accepted YAML attempt", async () => {
		const messages: ModelMessage[] = [{ role: "user", content: "respond" }];
		const rejected: ModelMessage[] = [
			{ role: "assistant", content: "not valid YAML" },
		];
		const accepted: ModelMessage[] = [
			{ role: "assistant", content: "value: repaired" },
		];
		let attempts = 0;
		__setProviderOverrideForTests("openai", async () => {
			attempts += 1;
			return {
				content: attempts === 1 ? "[" : "value: repaired",
				usage,
				reasoning_tokens: "",
				responseMessages: attempts === 1 ? rejected : accepted,
			};
		});

		const result = await chatYAML<{ value: string }>(
			messages,
			options,
			"accepted-native-messages-test",
		);

		assert.equal(attempts, 2);
		assert.strictEqual(result.responseMessages, accepted);
	});

	it("does not forward OpenAI-only response settings to another provider", async () => {
		const messages: ModelMessage[] = [{ role: "user", content: "respond" }];
		let request: ProviderChatArgs | undefined;
		__setProviderOverrideForTests("vllm", async (args) => {
			request = args;
			return {
				content: "value: ok",
				usage,
				reasoning_tokens: "",
				responseMessages: [{ role: "assistant", content: "value: ok" }],
			};
		});

		await chatYAML(
			messages,
			{
				...options,
				provider: "vllm",
				model: "Qwen/Qwen3.5-397B-A17B-FP8",
			},
			"native-non-openai-test",
			undefined,
			undefined,
			undefined,
			true,
			{
				promptCacheOptions: { mode: "explicit", ttl: "30m" },
			},
		);

		assert.strictEqual(request?.messages, messages);
		assert.isUndefined(request?.openAIEncryptedResponses);
		assert.isUndefined(request?.openAIPromptCache);
	});
});
