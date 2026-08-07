import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
	__setProviderOverrideForTests,
	OpenAIEncryptedContinuationError,
	type ProviderChatArgs,
} from "../src/agents/providers/ai-sdk.js";
import {
	chatYAML,
	OpenAIContinuationError,
} from "../src/agents/providers/router.js";
import type { Message } from "../src/agents/types.js";

const options = {
	provider: "openai" as const,
	model: "gpt-5.6-terra",
	reasoningEffort: "medium" as const,
};

const usage = {
	input_tokens: 10,
	output_tokens: 2,
	total_tokens: 12,
};

const messages: Message[] = [
	{ role: "system", content: "CURRENT SYSTEM" },
	{ role: "user", content: "old payload" },
	{
		role: "assistant",
		content: "old answer",
		reasoning_tokens: "local summary",
	},
	{ role: "user", content: "current payload" },
];

const committedMessages = [
	{ role: "user" as const, content: "old payload" },
	{
		role: "assistant" as const,
		content: [
			{
				type: "reasoning" as const,
				text: "local summary",
				providerOptions: {
					openai: {
						itemId: "reasoning-1",
						reasoningEncryptedContent: "ciphertext",
					},
				},
			},
			{ type: "text" as const, text: "old answer" },
		],
	},
];

describe("OpenAI response continuation routing", () => {
	afterEach(() => {
		__setProviderOverrideForTests("openai", null);
		__setProviderOverrideForTests("vllm", null);
	});

	it("sends instructions and only messages added after the committed response", async () => {
		let request: ProviderChatArgs | undefined;
		__setProviderOverrideForTests("openai", async (args) => {
			request = args;
			return {
				content: "value: ok",
				usage,
				reasoning_tokens: "",
				providerContinuation: {
					provider: "openai",
					strategy: "cumulative",
					messages: [...committedMessages, { role: "user", content: "next" }],
				},
			};
		});

		const result = await chatYAML<{ value: string }>(
			messages,
			options,
			"continuation-test",
			undefined,
			undefined,
			undefined,
			{
				provider: "openai",
				strategy: "cumulative",
				messages: committedMessages,
				inputMode: "incremental",
				newMessageStartIndex: 3,
			},
		);

		assert.equal(request?.instructions, "CURRENT SYSTEM");
		assert.equal(request?.prompt, "USER:\ncurrent payload");
		assert.deepEqual(
			request?.providerContinuation?.messages,
			committedMessages,
		);
		assert.deepEqual(result.providerContinuation, {
			provider: "openai",
			strategy: "cumulative",
			messages: [...committedMessages, { role: "user", content: "next" }],
		});
	});

	it("sends reconstructed non-system history for a fresh chain", async () => {
		let request: ProviderChatArgs | undefined;
		__setProviderOverrideForTests("openai", async (args) => {
			request = args;
			return {
				content: "value: ok",
				usage,
				reasoning_tokens: "",
			};
		});

		await chatYAML(
			messages,
			options,
			"fresh-test",
			undefined,
			undefined,
			undefined,
			{
				provider: "openai",
				strategy: "cumulative",
				messages: [],
				inputMode: "full",
			},
		);

		assert.equal(request?.instructions, "CURRENT SYSTEM");
		assert.notInclude(request?.prompt ?? "", "SYSTEM:");
		assert.include(request?.prompt ?? "", "USER:\nold payload");
		assert.include(request?.prompt ?? "", "reasoning_tokens:");
		assert.include(request?.prompt ?? "", "USER:\ncurrent payload");
	});

	it("rebuilds current-mode history with encrypted reasoning and only the latest DOM", async () => {
		let request: ProviderChatArgs | undefined;
		__setProviderOverrideForTests("openai", async (args) => {
			request = args;
			return {
				content: "value: ok",
				usage,
				reasoning_tokens: "",
				providerContinuation: {
					provider: "openai",
					strategy: "current",
					reasoningMessages: [],
				},
			};
		});

		await chatYAML(
			[
				{ role: "system", content: "CURRENT SYSTEM" },
				{ role: "user", content: "compact prior payload" },
				{
					role: "assistant",
					content: "old answer",
					reasoning_tokens: "plaintext reasoning must not be sent",
				},
				{ role: "user", content: "DOM_3_ONLY" },
			],
			options,
			"current-replay-test",
			undefined,
			undefined,
			undefined,
			{
				provider: "openai",
				strategy: "current",
				reasoningStateByStep: [
					{
						messages: [
							{
								role: "assistant",
								content: [
									{
										type: "reasoning",
										text: "pruned reasoning",
										providerOptions: {
											openai: {
												reasoningEncryptedContent: "pruned-ciphertext",
											},
										},
									},
								],
							},
						],
						reasoningTokenCount: 2,
					},
					{
						messages: committedMessages.slice(1),
						reasoningTokenCount: 3,
					},
				],
			},
		);

		assert.deepEqual(request?.openAIInputMessages, [
			{ role: "user", content: "compact prior payload" },
			{
				role: "assistant",
				content: [
					(committedMessages[1] as any).content[0],
					{ type: "text", text: "old answer" },
				],
			},
			{ role: "user", content: "DOM_3_ONLY" },
		]);
		assert.notInclude(
			JSON.stringify(request?.openAIInputMessages),
			"plaintext reasoning",
		);
		assert.notInclude(JSON.stringify(request?.openAIInputMessages), "DOM_1");
		assert.notInclude(
			JSON.stringify(request?.openAIInputMessages),
			"pruned-ciphertext",
		);
	});

	it("preserves structured breakpoints without encrypted reasoning", async () => {
		let request: ProviderChatArgs | undefined;
		__setProviderOverrideForTests("openai", async (args) => {
			request = args;
			return { content: "value: ok", usage, reasoning_tokens: "" };
		});
		const breakpoint = {
			openai: { promptCacheBreakpoint: { mode: "explicit" } },
		};

		await chatYAML(
			[
				{
					role: "system",
					content: "STABLE SYSTEM",
					providerOptions: breakpoint,
				},
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "BEGIN CURRENT STEP",
							providerOptions: breakpoint,
						},
						{ type: "text", text: "MUTABLE PAGE" },
					],
				},
			],
			options,
			"explicit-cache-test",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				promptCacheKey: "stable-worker-key",
				promptCacheOptions: { mode: "explicit", ttl: "30m" },
			},
		);

		assert.isUndefined(request?.instructions);
		assert.deepEqual(request?.openAIPromptCache, {
			promptCacheKey: "stable-worker-key",
			promptCacheOptions: { mode: "explicit", ttl: "30m" },
		});
		assert.deepEqual(request?.openAIInputMessages, [
			{
				role: "system",
				content: "STABLE SYSTEM",
				providerOptions: breakpoint,
			},
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "BEGIN CURRENT STEP",
						providerOptions: breakpoint,
					},
					{ type: "text", text: "MUTABLE PAGE" },
				],
			},
		]);
	});

	it("keeps the same committed messages across YAML retries", async () => {
		const continuationInputs: unknown[] = [];
		let calls = 0;
		__setProviderOverrideForTests("openai", async (args) => {
			calls += 1;
			continuationInputs.push(args.providerContinuation?.messages);
			return {
				content: calls === 1 ? "[" : "value: repaired",
				usage,
				reasoning_tokens: "",
				providerContinuation: {
					provider: "openai",
					strategy: "cumulative",
					messages: [
						...committedMessages,
						{ role: "assistant", content: `candidate-${calls}` },
					],
				},
			};
		});

		const result = await chatYAML<{ value: string }>(
			messages,
			options,
			"yaml-retry-test",
			undefined,
			undefined,
			undefined,
			{
				provider: "openai",
				strategy: "cumulative",
				messages: committedMessages,
				inputMode: "incremental",
				newMessageStartIndex: 3,
			},
		);

		assert.deepEqual(continuationInputs, [
			committedMessages,
			committedMessages,
		]);
		assert.deepEqual(result.providerContinuation?.messages, [
			...committedMessages,
			{ role: "assistant", content: "candidate-2" },
		]);
		assert.deepInclude(result.usage, {
			input_tokens: 20,
			cached_input_tokens: 0,
			cache_write_tokens: 0,
			output_tokens: 4,
			total_tokens: 24,
		});
		assert.deepInclude(result.accepted_usage, usage);
	});

	it("does not apply OpenAI continuation options to another provider", async () => {
		let request: ProviderChatArgs | undefined;
		__setProviderOverrideForTests("vllm", async (args) => {
			request = args;
			return { content: "value: ok", usage, reasoning_tokens: "" };
		});

		await chatYAML(
			messages,
			{
				...options,
				provider: "vllm",
				model: "Qwen/Qwen3.5-397B-A17B-FP8",
			},
			"non-openai-test",
			undefined,
			undefined,
			undefined,
			{
				provider: "openai",
				strategy: "cumulative",
				messages: committedMessages,
				inputMode: "incremental",
			},
		);

		assert.isUndefined(request?.instructions);
		assert.isUndefined(request?.providerContinuation);
		assert.include(request?.prompt ?? "", "SYSTEM:\nCURRENT SYSTEM");
	});

	it("fails encrypted metadata errors without retries", async () => {
		let calls = 0;
		__setProviderOverrideForTests("openai", async () => {
			calls += 1;
			throw new OpenAIEncryptedContinuationError(
				"OpenAI encrypted continuation is missing reasoning metadata.",
			);
		});

		let caught: unknown;
		try {
			await chatYAML(
				messages,
				options,
				"missing-encrypted-state-test",
				undefined,
				undefined,
				undefined,
				{
					provider: "openai",
					strategy: "cumulative",
					messages: committedMessages,
					inputMode: "incremental",
					newMessageStartIndex: 3,
				},
			);
		} catch (error) {
			caught = error;
		}

		assert.instanceOf(caught, OpenAIEncryptedContinuationError);
		assert.equal(calls, 1);
	});

	it("surfaces context exhaustion with whether continuation state was used", async () => {
		let calls = 0;
		__setProviderOverrideForTests("openai", async () => {
			calls += 1;
			const error = new Error("maximum context length exceeded") as Error & {
				responseBody: string;
			};
			error.responseBody = JSON.stringify({
				error: { code: "context_length_exceeded" },
			});
			throw error;
		});

		let caught: unknown;
		try {
			await chatYAML(
				messages,
				options,
				"context-test",
				undefined,
				undefined,
				undefined,
				{
					provider: "openai",
					strategy: "cumulative",
					messages: committedMessages,
					inputMode: "incremental",
					newMessageStartIndex: 3,
				},
			);
		} catch (error) {
			caught = error;
		}

		assert.instanceOf(caught, OpenAIContinuationError);
		assert.equal((caught as OpenAIContinuationError).reason, "context_length");
		assert.isTrue((caught as OpenAIContinuationError).usedContinuationState);
		assert.equal(calls, 1);
	});
});
