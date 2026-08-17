import { assert } from "chai";
import { describe, it } from "mocha";
import {
	buildOpenAIExplicitNoCacheRequest,
	buildOpenAIPromptCacheRequest,
	isOpenAICacheMarkerPart,
	OPENAI_CURRENT_STEP_MARKER,
} from "../src/agents/openai-prompt-cache.js";
import { compileCustomTools } from "../src/custom-tools.js";
import { buildStepMessages } from "../src/agents/executor-utils/step-execution.js";
import type { Message } from "../src/agents/types.js";
import { configFeatureFlags } from "../src/config-feature-flags.js";
import { buildHistoryMessagesFromFullStepHistory } from "../src/core/history-adapter.js";
import { supportsOpenAIExplicitPromptCaching } from "../src/llm-capabilities.js";
import {
	NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
	OPENAI_EXECUTOR_CONTEXT_POLICY,
} from "../src/agents/executor-context-policy.js";

function tokenPrefixThroughMarker(
	messages: Message[],
	markerOrdinal: number,
): string {
	let seen = 0;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		const markerIndex = message.content.findIndex(isOpenAICacheMarkerPart);
		if (markerIndex === -1) continue;
		if (seen === markerOrdinal) {
			const prefix = [
				...messages.slice(0, index),
				{
					...message,
					content: message.content.slice(0, markerIndex + 1),
				},
			];
			return JSON.stringify(
				prefix.map((prefixMessage) => ({
					role: prefixMessage.role,
					content:
						typeof prefixMessage.content === "string"
							? prefixMessage.content
							: prefixMessage.content.map((part) =>
									part.type === "text"
										? { type: "text", text: part.text }
										: part,
								),
				})),
			);
		}
		seen += 1;
	}
	throw new Error(`Missing cache marker ${markerOrdinal}.`);
}

describe("OpenAI explicit prompt caching", () => {
	it("enables explicit controls only for OpenAI GPT-5.6 models", () => {
		assert.isTrue(
			supportsOpenAIExplicitPromptCaching("openai", "gpt-5.6-luna"),
		);
		assert.isTrue(
			supportsOpenAIExplicitPromptCaching(
				"openai",
				"gpt-5.6-luna-2026-08-01",
			),
		);
		assert.isFalse(
			supportsOpenAIExplicitPromptCaching("openai", "gpt-5.5"),
		);
		assert.isFalse(
			supportsOpenAIExplicitPromptCaching("openrouter", "gpt-5.6-luna"),
		);
	});

	it("derives stable sharded keys from model and prompt configuration", () => {
		const base = {
			model: "gpt-5.6-luna",
			shard: "worker-3",
			featureFlags: { ...configFeatureFlags },
			executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY,
		};
		const first = buildOpenAIPromptCacheRequest(base);
		const second = buildOpenAIPromptCacheRequest({
			...base,
			featureFlags: { ...configFeatureFlags },
		});

		assert.deepEqual(first, second);
		assert.match(first.promptCacheKey, /^browser-agent:[a-f0-9]{32}$/);
		assert.deepEqual(first.promptCacheOptions, {
			mode: "explicit",
			ttl: "30m",
		});
		assert.notEqual(
			first.promptCacheKey,
			buildOpenAIPromptCacheRequest({ ...base, shard: "worker-4" })
				.promptCacheKey,
		);
		assert.notEqual(
			first.promptCacheKey,
			buildOpenAIPromptCacheRequest({
				...base,
				featureFlags: {
					...configFeatureFlags,
					preStepScreenshotInLatestUserPrompt:
						!configFeatureFlags.preStepScreenshotInLatestUserPrompt,
				},
			}).promptCacheKey,
		);
		assert.notEqual(
			first.promptCacheKey,
			buildOpenAIPromptCacheRequest({
				...base,
				executorContextPolicy: NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
			}).promptCacheKey,
		);
		assert.notEqual(
			first.promptCacheKey,
			buildOpenAIPromptCacheRequest({
				...base,
				customTools: compileCustomTools([
					{
						name: "lookup_value",
						description: "Look up a value.",
						arguments: { type: "object" },
						javascript: "() => true",
					},
				]),
			}).promptCacheKey,
		);
	});

	it("builds an explicit no-breakpoint policy for auxiliary calls", () => {
		assert.deepEqual(buildOpenAIExplicitNoCacheRequest(), {
			promptCacheOptions: { mode: "explicit", ttl: "30m" },
		});
	});

	it("keeps both rolling cache prefixes byte-identical across steps", () => {
		const systemPrompt = "Stable executor instructions";
		const payload1 = {
			currentURL: "https://example.com/one",
			projection: 'button ref="r1" name="One"',
		};
		const payload2 = {
			currentURL: "https://example.com/two",
			projection: 'button ref="r2" name="Two"',
		};
		const payload3 = {
			currentURL: "https://example.com/three",
			projection: 'button ref="r3" name="Three"',
		};
		const assistant1 = { tools: [{ click: "r1" }] };
		const assistant2 = { tools: [{ click: "r2" }] };
		const responseMessages1: Message[] = [
			{ role: "assistant", content: "original assistant 1" },
		];
		const responseMessages2: Message[] = [
			{ role: "assistant", content: "original assistant 2" },
		];

		const step1 = buildStepMessages({
			systemPrompt,
			history: [],
			payload: payload1,
			openAIExplicitPromptCaching: true,
		});
		const history1 = buildHistoryMessagesFromFullStepHistory(
			[
				{
					payload: payload1,
					assistant: assistant1,
					responseMessages: responseMessages1,
				},
			],
			{},
			{
				omitProjectionContext: true,
				openAIExplicitPromptCaching: true,
			},
		);
		const step2 = buildStepMessages({
			systemPrompt,
			history: history1,
			payload: payload2,
			openAIExplicitPromptCaching: true,
		});
		const history2 = buildHistoryMessagesFromFullStepHistory(
			[
				{
					payload: payload1,
					assistant: assistant1,
					responseMessages: responseMessages1,
				},
				{
					payload: payload2,
					assistant: assistant2,
					responseMessages: responseMessages2,
				},
			],
			{},
			{
				omitProjectionContext: true,
				openAIExplicitPromptCaching: true,
			},
		);
		const step3 = buildStepMessages({
			systemPrompt,
			history: history2,
			payload: payload3,
			openAIExplicitPromptCaching: true,
		});

		assert.deepEqual(step1[0].providerOptions, {
			openai: { promptCacheBreakpoint: { mode: "explicit" } },
		});
		assert.equal(
			tokenPrefixThroughMarker(step1, 0),
			tokenPrefixThroughMarker(step2, 0),
		);
		assert.equal(
			tokenPrefixThroughMarker(step2, 1),
			tokenPrefixThroughMarker(step3, 0),
		);

		const countBreakpoints = (messages: Message[]) =>
			messages.reduce(
				(count, message) =>
					count +
					(message.providerOptions?.openai?.promptCacheBreakpoint ? 1 : 0) +
					(Array.isArray(message.content)
						? message.content.filter(isOpenAICacheMarkerPart).length
						: 0),
				0,
			);
		assert.equal(countBreakpoints(step1), 2);
		assert.equal(countBreakpoints(step2), 3);
		assert.equal(countBreakpoints(step3), 3);

		const oldestHistorical = step3[1];
		assert.isArray(oldestHistorical.content);
		if (!Array.isArray(oldestHistorical.content)) {
			throw new Error("Expected structured historical user content.");
		}
		assert.equal(oldestHistorical.content[0].type, "text");
		if (oldestHistorical.content[0].type !== "text") {
			throw new Error("Expected a text marker.");
		}
		assert.equal(oldestHistorical.content[0].text, OPENAI_CURRENT_STEP_MARKER);
		assert.isFalse(isOpenAICacheMarkerPart(oldestHistorical.content[0]));

		const step1Current = step1[1];
		const step2Historical = step2[1];
		assert.isArray(step1Current.content);
		assert.isArray(step2Historical.content);
		if (
			!Array.isArray(step1Current.content) ||
			!Array.isArray(step2Historical.content)
		) {
			throw new Error("Expected structured cacheable user content.");
		}
		assert.isTrue(isOpenAICacheMarkerPart(step1Current.content[0]));
		assert.isTrue(isOpenAICacheMarkerPart(step2Historical.content[0]));
		assert.include(step1Current.content[1].text, "projection:");
		assert.notInclude(step2Historical.content[1].text, "projection:");
	});
});
