import { assert } from "chai";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import { buildStepMessages } from "../src/agents/executor-utils/step-execution.js";
import type { LLMOptions, Message } from "../src/agents/types.js";
import {
	estimateMessagesTokenCount,
	fitStepPromptToBudget,
} from "../src/core/prompt-budget.js";
import { PromptBudgetExceededError } from "../src/core/prompt-budget.js";

function estimateTokenCount(text: string): number {
	return text.length;
}

function estimateMessages(messages: Message[]): number {
	return estimateMessagesTokenCount(messages, estimateTokenCount);
}

function makeBudget(maxInputTokens: number): LLMOptions {
	return {
		provider: "openai",
		model: "gpt-test",
		maxModelLen: maxInputTokens + 10,
		reserveOutputTokens: 10,
	};
}

function makeVllmBudget(maxInputTokens: number): LLMOptions {
	return {
		provider: "vllm",
		model: "test-model",
		vllmBaseURL: "http://localhost:8000/v1",
		maxModelLen: maxInputTokens + 10 + 4096,
		reserveOutputTokens: 10,
	};
}

describe("prompt-budget", () => {
	it("estimates native messages per part without building a transcript", () => {
		const inputs: string[] = [];
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "current payload" },
					{
						type: "file",
						data: "SCREENSHOT_BASE64_MUST_NOT_BE_TOKENIZED_AS_TEXT",
						mediaType: "image/jpeg",
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "prior reasoning",
						providerOptions: {
							anthropic: { signature: "provider signature" },
						},
					},
					{ type: "text", text: "accepted output" },
				],
			},
		];

		const count = estimateMessagesTokenCount(messages, (text) => {
			inputs.push(text);
			return text.length;
		});

		assert.isAbove(count, 0);
		assert.include(inputs, "current payload");
		assert.include(inputs, "prior reasoning");
		assert.include(inputs, "provider signature");
		assert.notInclude(inputs, "SCREENSHOT_BASE64_MUST_NOT_BE_TOKENIZED_AS_TEXT");
		assert.isFalse(
			inputs.some(
				(text) =>
					text.includes("current payload") && text.includes("prior reasoning"),
			),
		);
	});

	it("is a no-op when no prompt budget is configured", () => {
		const result = fitStepPromptToBudget({
			systemPrompt: "SYSTEM",
			history: [
				{ role: "user", content: "history-user" },
				{ role: "assistant", content: "history-assistant" },
			],
			payload: {
				projection: "hello",
				currentPageScreenshotIncludedAsImagePart: true,
			},
			buildStepMessages,
			estimateTokenCount,
			currentPageScreenshotDataUrl: "data:image/jpeg;base64,BBBB",
		});

		assert.strictEqual(result.payload.projection, "hello");
		assert.strictEqual(
			result.currentPageScreenshotDataUrl,
			"data:image/jpeg;base64,BBBB",
		);
		assert.include(JSON.stringify(result.messages), "history-user");
	});

	it("drops screenshots before trimming history or projection", () => {
		const history: Message[] = [
			{ role: "user", content: "history-user" },
			{ role: "assistant", content: "history-assistant" },
		];
		const payload = {
			projection: "small-projection",
			currentPageScreenshotIncludedAsImagePart: true,
		};
		const fullMessages = buildStepMessages({
			systemPrompt: "SYSTEM",
			history,
			payload,
			currentPageScreenshotDataUrl: "data:image/jpeg;base64,BBBB",
		});
		const withoutImagesMessages = buildStepMessages({
			systemPrompt: "SYSTEM",
			history,
			payload: { projection: "small-projection" },
		});
		const result = fitStepPromptToBudget({
			llmOptions: makeBudget(estimateMessages(withoutImagesMessages)),
			systemPrompt: "SYSTEM",
			history,
			payload,
			buildStepMessages,
			estimateTokenCount,
			currentPageScreenshotDataUrl: "data:image/jpeg;base64,BBBB",
		});

		assert.isAbove(
			estimateMessages(fullMessages),
			estimateMessages(withoutImagesMessages),
		);
		assert.strictEqual(result.currentPageScreenshotDataUrl, undefined);
		assert.include(JSON.stringify(result.messages), "history-user");
		assert.strictEqual(result.payload.projection, "small-projection");
		assert.notProperty(
			result.payload,
			"currentPageScreenshotIncludedAsImagePart",
		);
	});

	it("trims oldest history before truncating projection", () => {
		const history: Message[] = [
			{ role: "user", content: "history-user-1" },
			{ role: "assistant", content: "history-assistant-1" },
		];
		const payload = {
			projection: "projection-that-should-stay-intact",
		};
		const withoutHistoryMessages = buildStepMessages({
			systemPrompt: "SYSTEM",
			history: [],
			payload,
		});
		const result = fitStepPromptToBudget({
			llmOptions: makeBudget(estimateMessages(withoutHistoryMessages)),
			systemPrompt: "SYSTEM",
			history,
			payload,
			buildStepMessages,
			estimateTokenCount,
		});

		assert.strictEqual(
			result.payload.projection,
			"projection-that-should-stay-intact",
		);
		assert.notInclude(JSON.stringify(result.messages), "history-user-1");
	});

	it("drops the oldest native reasoning before removing complete turns", () => {
		const history: Message[] = [
			{ role: "user", content: "history-user-1" },
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "old-reasoning-".repeat(80),
						providerOptions: {
							anthropic: { signature: "old-signature" },
						},
					},
					{ type: "text", text: "history-assistant-1" },
				],
			},
			{ role: "user", content: "history-user-2" },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "new-reasoning" },
					{ type: "text", text: "history-assistant-2" },
				],
			},
		];
		const payload = { projection: "current projection" };
		const withoutOldestReasoning: Message[] = [
			history[0]!,
			{
				role: "assistant",
				content: [{ type: "text", text: "history-assistant-1" }],
			},
			...history.slice(2),
		];
		const fittingMessages = buildStepMessages({
			systemPrompt: "SYSTEM",
			history: withoutOldestReasoning,
			payload,
		});

		const result = fitStepPromptToBudget({
			llmOptions: makeBudget(estimateMessages(fittingMessages)),
			systemPrompt: "SYSTEM",
			history,
			payload,
			buildStepMessages,
			estimateTokenCount,
			projectionHistoryContext: {
				enabled: true,
				canonicalProjection: "current projection",
			},
		});

		const serialized = JSON.stringify(result.messages);
		assert.include(result.budgetReport.reductions, "drop_oldest_reasoning");
		assert.notInclude(result.budgetReport.reductions, "drop_oldest_history_pair");
		assert.notInclude(serialized, "old-reasoning-");
		assert.notInclude(serialized, "old-signature");
		assert.include(serialized, "history-user-1");
		assert.include(serialized, "history-assistant-1");
		assert.include(serialized, "new-reasoning");
	});

	it("drops every response message in the oldest cumulative turn as one unit", () => {
		const history: Message[] = [
			{ role: "user", content: "old-user" },
			{ role: "assistant", content: "old-assistant-part-1" },
			{ role: "assistant", content: "old-assistant-part-2" },
			{ role: "user", content: "kept-user" },
			{ role: "assistant", content: "kept-assistant" },
		];
		const payload = {
			projectionContextMode: "reset",
			projection: "current projection",
		};
		const fittingMessages = buildStepMessages({
			systemPrompt: "SYSTEM",
			history: history.slice(3),
			payload,
		});
		const result = fitStepPromptToBudget({
			llmOptions: makeBudget(estimateMessages(fittingMessages)),
			systemPrompt: "SYSTEM",
			history,
			payload,
			buildStepMessages,
			estimateTokenCount,
			projectionHistoryContext: {
				enabled: true,
				canonicalProjection: "current projection",
			},
		});

		const serialized = JSON.stringify(result.messages);
		assert.include(result.budgetReport.reductions, "drop_oldest_history_pair");
		assert.notInclude(serialized, "old-user");
		assert.notInclude(serialized, "old-assistant-part-1");
		assert.notInclude(serialized, "old-assistant-part-2");
		assert.include(serialized, "kept-user");
		assert.include(serialized, "kept-assistant");
	});

	it("truncates projection as the final fallback", () => {
		const payload = {
			projection: "A".repeat(400),
		};
		const result = fitStepPromptToBudget({
			llmOptions: makeBudget(180),
			systemPrompt: "SYSTEM",
			history: [],
			payload,
			buildStepMessages,
			estimateTokenCount,
		});

		assert.isString(result.payload.projection);
		assert.notStrictEqual(result.payload.projection, payload.projection);
		assert.include(
			String(result.payload.projection),
			"...[projection truncated for context budget]...",
		);
	});

	it("applies an extra safety margin for vllm prompt budgets", () => {
		const payload = {
			projection: "A".repeat(400),
		};
		const result = fitStepPromptToBudget({
			llmOptions: makeVllmBudget(180),
			systemPrompt: "SYSTEM",
			history: [],
			payload,
			buildStepMessages,
			estimateTokenCount,
		});

		assert.isString(result.payload.projection);
		assert.notStrictEqual(result.payload.projection, payload.projection);
		assert.include(
			String(result.payload.projection),
			"...[projection truncated for context budget]...",
		);
	});

	it("checkpoints a delta to a reset without evicting assistant history", () => {
		const canonicalProjection = "current-line\n".repeat(20);
		const history: Message[] = [
			{
				role: "user",
				content: yaml.dump({
					currentURL: "https://example.com",
					projectionContextMode: "reset",
					projection: "old-line\n".repeat(60),
				}),
			},
			{ role: "assistant", content: "tools: []" },
		];
		const payload = {
			currentURL: "https://example.com",
			projectionContextMode: "delta",
			projection: "@@ -1,1 +1,1 @@\n-old\n+new",
		};
		const rebasedHistory: Message[] = [
			{
				role: "user",
				content: yaml.dump({
					currentURL: "https://example.com",
				}),
			},
			history[1],
		];
		const rebasedMessages = buildStepMessages({
			systemPrompt: "SYSTEM",
			history: rebasedHistory,
			payload: {
				...payload,
				projectionContextMode: "reset",
				projection: canonicalProjection,
			},
		});

		const result = fitStepPromptToBudget({
			llmOptions: makeBudget(estimateMessages(rebasedMessages)),
			systemPrompt: "SYSTEM",
			history,
			payload,
			buildStepMessages,
			estimateTokenCount,
			projectionHistoryContext: {
				enabled: true,
				canonicalProjection,
			},
		});

		assert.strictEqual(result.payload.projectionContextMode, "reset");
		assert.strictEqual(result.payload.projection, canonicalProjection);
		assert.notInclude(JSON.stringify(result.messages), "old-line");
		assert.include(JSON.stringify(result.messages), "currentURL");
		assert.include(JSON.stringify(result.messages), "tools: []");
		assert.include(
			result.budgetReport.reductions,
			"checkpoint_cumulative_projection_history",
		);
	});

	it("fails before provider execution when irreducible executor context is oversized", () => {
		assert.throws(
			() =>
				fitStepPromptToBudget({
					llmOptions: makeBudget(1),
					systemPrompt: "SYSTEM PROMPT CANNOT FIT",
					history: [],
					payload: {},
					buildStepMessages,
					estimateTokenCount,
				}),
			PromptBudgetExceededError,
		);
	});
});
