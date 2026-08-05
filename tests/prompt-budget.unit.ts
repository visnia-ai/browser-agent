import { assert } from "chai";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import { buildStepMessages } from "../src/agents/executor-utils/step-execution.js";
import type { LLMOptions, Message } from "../src/agents/types.js";
import { fitStepPromptToBudget } from "../src/core/prompt-budget.js";
import { PromptBudgetExceededError } from "../src/core/prompt-budget.js";

function estimateTokenCount(text: string): number {
	return text.length;
}

function flattenContentForEstimate(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => (part.type === "text" ? part.text : "[image]"))
		.join("\n");
}

function estimateMessages(messages: Message[]): number {
	return estimateTokenCount(
		messages
			.map(
				(message) =>
					`${message.role}:\n${flattenContentForEstimate(message.content)}`,
			)
			.join("\n\n"),
	);
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
