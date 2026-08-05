import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { countMessageTokens } from "../src/agents/providers/router.js";
import { __setOpenAIClientForTests } from "../src/agents/providers/ai-sdk.js";
import type { Message } from "../src/agents/types.js";

describe("router token counting", () => {
	afterEach(() => {
		__setOpenAIClientForTests(null);
	});

	it("uses the configured OpenAI model for text-only messages", async () => {
		const calls: Array<Record<string, unknown>> = [];
		__setOpenAIClientForTests({
			responses: {
				inputTokens: {
					count: async (body: Record<string, unknown>) => {
						calls.push(body);
						return {
							object: "response.input_tokens",
							input_tokens: 321,
						};
					},
				},
			},
		} as any);

		const messages: Message[] = [
			{ role: "system", content: "You are a helpful assistant." },
			{ role: "user", content: "Summarize this page." },
		];
		const inputTokens = await countMessageTokens(messages, {
			provider: "openai",
			model: "gpt-5.2-mini",
		});

		assert.strictEqual(inputTokens, 321);
		assert.lengthOf(calls, 1);
		assert.strictEqual(calls[0].model, "gpt-5.2-mini");
		assert.isString(calls[0].input);
		assert.include(
			calls[0].input as string,
			"SYSTEM:\nYou are a helpful assistant.",
		);
		assert.include(calls[0].input as string, "USER:\nSummarize this page.");
	});

	it("defaults to OpenAI token counting for together and vllm providers", async () => {
		const calls: Array<Record<string, unknown>> = [];
		__setOpenAIClientForTests({
			responses: {
				inputTokens: {
					count: async (body: Record<string, unknown>) => {
						calls.push(body);
						return {
							object: "response.input_tokens",
							input_tokens: 123,
						};
					},
				},
			},
		} as any);

		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in this image?" },
					{
						type: "image_url",
						image_url: {
							url: "data:image/png;base64,AAA",
							detail: "low",
						},
					},
				],
			},
		];
		const expectedModel = "gpt-5.2";

		for (const provider of ["together", "vllm"] as const) {
			const inputTokens = await countMessageTokens(messages, {
				provider,
				model: "non-openai-model",
			});
			assert.strictEqual(inputTokens, 123);
		}

		assert.lengthOf(calls, 2);
		for (const call of calls) {
			assert.strictEqual(call.model, expectedModel);
			assert.isArray(call.input);
			const inputItems = call.input as Array<Record<string, unknown>>;
			assert.lengthOf(inputItems, 1);
			assert.strictEqual(inputItems[0].role, "user");
			assert.isArray(inputItems[0].content);
			const parts = inputItems[0].content as Array<
				Record<string, unknown>
			>;
			assert.deepInclude(parts, {
				type: "input_image",
				image_url: "data:image/png;base64,AAA",
				detail: "low",
			});
			const textPart = parts.find((part) => part.type === "input_text");
			assert.isDefined(textPart);
			assert.include(String(textPart?.text ?? ""), "[image omitted]");
		}
	});

	it("omits redacted base64 image_url entries when counting tokens", async () => {
		const calls: Array<Record<string, unknown>> = [];
		__setOpenAIClientForTests({
			responses: {
				inputTokens: {
					count: async (body: Record<string, unknown>) => {
						calls.push(body);
						return {
							object: "response.input_tokens",
							input_tokens: 42,
						};
					},
				},
			},
		} as any);

		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Analyze this step payload." },
					{
						type: "image_url",
						image_url: {
							url: "(base64 omitted)",
							detail: "auto",
						},
					},
				],
			},
		];

		const inputTokens = await countMessageTokens(messages, {
			provider: "openai",
			model: "gpt-5.2-mini",
		});
		assert.strictEqual(inputTokens, 42);
		assert.lengthOf(calls, 1);
		assert.isString(calls[0].input);
		assert.notInclude(String(calls[0].input), "(base64 omitted)");
	});
});
