import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import yaml from "js-yaml";
import {
	buildDataExtractionPromptChunks,
	extractDataResultsFromSnapshot,
} from "../src/agents/data-extraction.js";
import {
	buildSuccessVerificationMessages,
	fitSuccessVerificationPromptToBudget,
	type VerifyTaskSuccessInput,
} from "../src/agents/success-verifier.js";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";
import type { LLMOptions, Message } from "../src/agents/types.js";
import { toCompletionPrompt } from "../src/agents/providers/message-serialization.js";
import { chatYAML } from "../src/agents/providers/router.js";
import { PromptBudgetExceededError } from "../src/core/prompt-budget.js";

function estimateCharacters(text: string): number {
	return text.length;
}

function budget(maxInputTokens: number): LLMOptions {
	return {
		provider: "openai",
		model: "gpt-test",
		reasoningEffort: "low",
		maxModelLen: maxInputTokens + 10,
		reserveOutputTokens: 10,
	};
}

function messageCharacters(messages: Message[]): number {
	return toCompletionPrompt(messages).length;
}

function verifierInput(
	overrides: Partial<VerifyTaskSuccessInput> = {},
): VerifyTaskSuccessInput {
	return {
		task: "Return every matching item.",
		executedSteps: 8,
		maxSteps: 20,
		finalStep: {
			thinking: "reasoning ".repeat(100),
			previousStepStatus: "progressed",
			previousStepOutcome: "Found results",
			currentStateObservation: "Results visible",
			nextActionRationale: "Return results",
			actions: [{ type: "return_results" }],
			done: true,
			result: '- link: "https://example.com/one"\n  summary: "One"',
		},
		finalPromptPayload: {
			currentURL: "https://example.com/results",
			projection: "semantic projection ".repeat(1000),
			interactionErrors: [],
		},
		checklist: [
			{ id: "C1", requirement: "Return every item.", status: "DONE" },
		],
		historyMessages: Array.from({ length: 6 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `history-${index} ${"payload ".repeat(100)}`,
		})) as Message[],
		llmOptions: {
			provider: "openai",
			model: "gpt-test",
			reasoningEffort: "low",
		},
		purpose: "completion_verifier",
		contextMode: "full",
		estimateTokenCount: estimateCharacters,
		...overrides,
	};
}

afterEach(() => {
	__setProviderOverrideForTests("openai", null);
});

describe("stage prompt budgeting", () => {
	it("covers oversized extraction projections with stable, fitting chunks", () => {
		const pageProjection = Array.from(
			{ length: 12 },
			(_, index) =>
				`article href="/item-${index}": ${`Item ${index} `.repeat(12)}`,
		).join("\n");
		const baseInput = {
			task: "Extract every item",
			currentUrl: "https://example.com",
			pageProjection,
			llmOptions: {
				provider: "openai",
				model: "gpt-test",
				reasoningEffort: "low",
			} satisfies LLMOptions,
			estimateTokenCount: estimateCharacters,
		};
		const unbounded = buildDataExtractionPromptChunks(baseInput);
		const oneLine = buildDataExtractionPromptChunks({
			...baseInput,
			pageProjection: pageProjection.split("\n")[0],
		});
		const maxInputTokens = oneLine[0].budgetReport.finalInputTokens + 250;
		const chunks = buildDataExtractionPromptChunks({
			...baseInput,
			llmOptions: budget(maxInputTokens),
		});

		assert.lengthOf(unbounded, 1);
		assert.isAbove(chunks.length, 1);
		assert.strictEqual(
			chunks.flatMap((chunk) => chunk.pageProjection.split("\n")).length,
			12,
		);
		assert.deepEqual(
			chunks.flatMap((chunk) =>
				[...chunk.linksById.keys()].filter(
					(linkId) => linkId !== "link_current",
				),
			),
			Array.from({ length: 12 }, (_, index) => `link_${index + 1}`),
		);
		for (const chunk of chunks) {
			assert.isAtMost(chunk.budgetReport.finalInputTokens, maxInputTokens);
		}
	});

	it("aggregates chunked extraction results in page order", async () => {
		const pageProjection = Array.from(
			{ length: 8 },
			(_, index) =>
				`article href="/item-${index}": ${`Item ${index} `.repeat(16)}`,
		).join("\n");
		const unboundedInput = {
			task: "Extract every item",
			currentUrl: "https://example.com",
			pageProjection,
			llmOptions: {
				provider: "openai",
				model: "gpt-test",
				reasoningEffort: "low",
			} satisfies LLMOptions,
			estimateTokenCount: estimateCharacters,
		};
		const oneLine = buildDataExtractionPromptChunks({
			...unboundedInput,
			pageProjection: pageProjection.split("\n")[0],
		});
		let calls = 0;
		__setProviderOverrideForTests("openai", async ({ prompt }) => {
			calls++;
			const ids = [...prompt.matchAll(/\blink_id="(link_\d+)"/g)].map(
				(match) => match[1],
			);
			return {
				content: [
					"items:",
					...ids.flatMap((id) => [
						`  - link_id: ${id}`,
						`    summary: Summary ${id}`,
					]),
				].join("\n"),
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
				},
				reasoning_tokens: "",
			};
		});

		const result = await extractDataResultsFromSnapshot({
			...unboundedInput,
			llmOptions: budget(oneLine[0].budgetReport.finalInputTokens + 300),
		});
		assert.isAbove(calls, 1);
		assert.deepEqual(
			result.items.map((item) => item.link),
			Array.from(
				{ length: 8 },
				(_, index) => `https://example.com/item-${index}`,
			),
		);
	});

	it("falls back from full verification to an exact compact result", () => {
		const compact = buildSuccessVerificationMessages(
			verifierInput({ contextMode: "compact" }),
		);
		const maxInputTokens = messageCharacters(compact.messages) + 10;
		const input = verifierInput({
			llmOptions: budget(maxInputTokens),
		});
		const fitted = fitSuccessVerificationPromptToBudget(input);

		assert.strictEqual(fitted.budgetMode, "compact");
		assert.isAtMost(fitted.budgetReport.finalInputTokens, maxInputTokens);
		const content = fitted.messages[1].content;
		assert.isString(content);
		const payload = yaml.load(content as string) as {
			candidateResult?: string;
		};
		assert.strictEqual(payload.candidateResult, input.finalStep.result);
		assert.include(fitted.budgetReport.reductions, "fallback_to_compact");
	});

	it("uses budgeted full verification when removing the redundant projection is enough", () => {
		const withoutLargeProjection = verifierInput({
			finalPromptPayload: {
				currentURL: "https://example.com/results",
				interactionErrors: [],
			},
			finalStep: {
				...verifierInput().finalStep,
				thinking: "",
			},
			historyMessages: [],
		});
		const slim = buildSuccessVerificationMessages(withoutLargeProjection);
		const fitted = fitSuccessVerificationPromptToBudget(
			verifierInput({
				llmOptions: budget(messageCharacters(slim.messages) + 100),
			}),
		);

		assert.strictEqual(fitted.budgetMode, "budgeted_full");
		assert.strictEqual(fitted.contextMode, "full");
		assert.include(
			fitted.budgetReport.reductions,
			"strip_redundant_full_context",
		);
	});

	it("enforces the configured budget at the shared chat boundary", async () => {
		let providerCalled = false;
		__setProviderOverrideForTests("openai", async () => {
			providerCalled = true;
			throw new Error("provider should not be called");
		});

		try {
			await chatYAML(
				[
					{
						role: "user",
						content: "This prompt cannot fit into one token.",
					},
				],
				budget(1),
				"budget-guard-test",
			);
			assert.fail("Expected prompt budget rejection");
		} catch (error) {
			assert.instanceOf(error, PromptBudgetExceededError);
		}
		assert.isFalse(providerCalled);
	});
});
