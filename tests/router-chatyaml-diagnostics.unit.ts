import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import type { TextStreamPart, ToolSet } from "ai";
import { chat, chatYAML } from "../src/agents/providers/router.js";
import {
	__collectStreamedTextForTests,
	__createFinalOutputStopTransformForTests,
	__setProviderOverrideForTests,
	type ProviderChatArgs,
} from "../src/agents/providers/ai-sdk.js";

const STALL_LOG_INTERVAL_MS_ENV =
	"BROWSER_AGENT_CHAT_YAML_STALL_LOG_INTERVAL_MS";

async function applyFinalOutputStopTransform(
	parts: TextStreamPart<ToolSet>[],
	stopSequences: readonly string[],
): Promise<{
	parts: TextStreamPart<ToolSet>[];
	stoppedSequences: string[];
	stopStreamCalls: number;
}> {
	const stoppedSequences: string[] = [];
	let stopStreamCalls = 0;
	const transform = __createFinalOutputStopTransformForTests<ToolSet>({
		stopSequences,
		onStop: (sequence) => stoppedSequences.push(sequence),
	})({
		tools: {},
		stopStream: () => {
			stopStreamCalls += 1;
		},
	});
	const outputPromise = (async () => {
		const transformedParts: TextStreamPart<ToolSet>[] = [];
		const reader = transform.readable.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				return transformedParts;
			}
			transformedParts.push(value);
		}
	})();
	const writer = transform.writable.getWriter();
	for (const part of parts) {
		await writer.write(part);
	}
	await writer.close();
	return { parts: await outputPromise, stoppedSequences, stopStreamCalls };
}

function joinedTextDeltas(parts: TextStreamPart<ToolSet>[]): string {
	return parts
		.filter(
			(part): part is Extract<typeof part, { type: "text-delta" }> =>
				part.type === "text-delta",
		)
		.map((part) => part.text)
		.join("");
}

describe("router chatYAML diagnostics", () => {
	const originalConsoleLog = console.log;
	let logs: string[];

	beforeEach(() => {
		logs = [];
		console.log = (...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		};
	});

	afterEach(() => {
		console.log = originalConsoleLog;
		__setProviderOverrideForTests("openai", null);
		delete process.env[STALL_LOG_INTERVAL_MS_ENV];
	});

	it("assembles and forwards streamed chunks without logging their content", async () => {
		const chunks = ['value: "', "stream-secret-value", '"'];
		const forwardedChunks: string[] = [];
		const collectedChunks = await __collectStreamedTextForTests(
			(async function* () {
				yield* chunks;
			})(),
			(chunk) => forwardedChunks.push(chunk),
		);

		assert.deepEqual(collectedChunks, chunks);
		assert.deepEqual(forwardedChunks, chunks);
		assert.isFalse(logs.some((entry) => entry.includes("stream-secret-value")));
	});

	it("stops final output at the retained YAML closing marker", async () => {
		const providerUsage = {
			inputTokens: 1200,
			inputTokenDetails: {
				noCacheTokens: 100,
				cacheReadTokens: 1000,
				cacheWriteTokens: 100,
			},
			outputTokens: 5,
			outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
			totalTokens: 1205,
		};
		const result = await applyFinalOutputStopTransform(
			[
				{ type: "text-start", id: "text-1" },
				{
					type: "text-delta",
					id: "text-1",
					text: "<yaml>\nvalue: accepted\n</yaml>discarded",
				},
				{ type: "text-delta", id: "text-1", text: "also discarded" },
				{ type: "text-end", id: "text-1" },
				{
					type: "finish",
					finishReason: "stop",
					rawFinishReason: "stop",
					totalUsage: providerUsage,
				},
			],
			["</yaml>"],
		);

		assert.strictEqual(
			joinedTextDeltas(result.parts),
			"<yaml>\nvalue: accepted\n</yaml>",
		);
		assert.deepEqual(result.stoppedSequences, ["</yaml>"]);
		assert.strictEqual(result.stopStreamCalls, 0);
		const finish = result.parts.find((part) => part.type === "finish");
		assert.exists(finish);
		assert.deepEqual(
			finish?.type === "finish" ? finish.totalUsage : undefined,
			providerUsage,
		);
	});

	it("detects split output markers while ignoring reasoning markers", async () => {
		const result = await applyFinalOutputStopTransform(
			[
				{ type: "reasoning-start", id: "reasoning-1" },
				{
					type: "reasoning-delta",
					id: "reasoning-1",
					text: "consider the literal </yaml> here",
				},
				{ type: "reasoning-end", id: "reasoning-1" },
				{ type: "text-start", id: "text-1" },
				{ type: "text-delta", id: "text-1", text: "<yaml>\nvalue: 1\n</ya" },
				{ type: "text-delta", id: "text-1", text: "ml>ignored" },
			],
			["</yaml>"],
		);

		assert.strictEqual(
			joinedTextDeltas(result.parts),
			"<yaml>\nvalue: 1\n</yaml>",
		);
		assert.isTrue(
			result.parts.some(
				(part) =>
					part.type === "reasoning-delta" && part.text.includes("</yaml>"),
			),
		);
		assert.deepEqual(result.stoppedSequences, ["</yaml>"]);
		assert.strictEqual(result.stopStreamCalls, 0);
	});

	it("flushes unmatched output and supports disabling stop sequences", async () => {
		const parts: TextStreamPart<ToolSet>[] = [
			{ type: "text-start", id: "text-1" },
			{ type: "text-delta", id: "text-1", text: "value: </yam" },
			{ type: "text-end", id: "text-1" },
		];
		const unmatched = await applyFinalOutputStopTransform(parts, ["</yaml>"]);
		const disabled = await applyFinalOutputStopTransform(parts, []);

		assert.strictEqual(joinedTextDeltas(unmatched.parts), "value: </yam");
		assert.strictEqual(joinedTextDeltas(disabled.parts), "value: </yam");
		assert.deepEqual(unmatched.stoppedSequences, []);
		assert.deepEqual(disabled.stoppedSequences, []);
		assert.strictEqual(unmatched.stopStreamCalls, 0);
		assert.strictEqual(disabled.stopStreamCalls, 0);
	});

	it("configures YAML stops only for chatYAML", async () => {
		const observedStopSequences: Array<readonly string[] | undefined> = [];
		__setProviderOverrideForTests("openai", async (args) => {
			observedStopSequences.push(args.outputStopSequences);
			return {
				content: "<yaml>\nvalue: accepted\n</yaml>",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				reasoning_tokens: "",
			};
		});

		await chatYAML<{ value: string }>([{ role: "user", content: "yaml" }], {
			provider: "openai",
			model: "gpt-test",
		});
		await chat([{ role: "user", content: "text" }], {
			provider: "openai",
			model: "gpt-test",
		});

		assert.deepEqual(observedStopSequences, [[], undefined]);
	});

	it("logs lifecycle milestones, records TTFT, and omits prompt and response content", async () => {
		__setProviderOverrideForTests("openai", async (args) => {
			args.onLifecycleEvent?.({
				type: "first_delta",
				deltaType: "reasoning",
			});
			args.onLifecycleEvent?.({ type: "first_text_delta" });
			args.onLifecycleEvent?.({
				type: "output_stop_sequence",
				sequence: "</yaml>",
			});
			args.onLifecycleEvent?.({
				type: "text_stream_complete",
				chunkCount: 2,
				outputCharacters: 30,
			});
			args.onLifecycleEvent?.({ type: "usage_complete" });
			return {
				content: 'value: "response-secret-value"',
				usage: {
					input_tokens: 20,
					cached_input_tokens: 10,
					output_tokens: 4,
					total_tokens: 24,
				},
				reasoning_tokens: "",
			};
		});

		const result = await chatYAML<{ value: string }>(
			[{ role: "user", content: "prompt-secret-value" }],
			{
				provider: "openai",
				model: "gpt-test",
			},
			"diagnostics-test",
		);

		assert.strictEqual(result.data.value, "response-secret-value");
		assert.strictEqual(
			result.raw_response,
			'value: "response-secret-value"',
		);
		assert.isNumber(result.usage.time_to_first_token_ms);
		const events = logs.filter((entry) => entry.includes("[LLM][chatYAML]"));
		const eventIndex = (event: string) =>
			events.findIndex((entry) => entry.includes(`event=${event}`));
		assert.isAtLeast(eventIndex("request_start"), 0);
		assert.isAbove(eventIndex("first_delta"), eventIndex("request_start"));
		assert.isAbove(eventIndex("first_text_delta"), eventIndex("first_delta"));
		assert.isAbove(
			eventIndex("output_stop_sequence"),
			eventIndex("first_text_delta"),
		);
		assert.isAbove(
			eventIndex("text_stream_complete"),
			eventIndex("output_stop_sequence"),
		);
		assert.isAbove(
			eventIndex("usage_complete"),
			eventIndex("text_stream_complete"),
		);
		assert.isAbove(
			eventIndex("provider_complete"),
			eventIndex("usage_complete"),
		);
		assert.isAbove(
			eventIndex("parse_complete"),
			eventIndex("provider_complete"),
		);
		assert.isAbove(
			eventIndex("operation_complete"),
			eventIndex("parse_complete"),
		);
		assert.isTrue(
			events.some(
				(entry) =>
					entry.includes("event=request_start") &&
					entry.includes('prompt_cache_mode="implicit"'),
			),
		);
		assert.isTrue(
			events.some(
				(entry) =>
					entry.includes("event=provider_complete") &&
					entry.includes("cached_input_tokens=10") &&
					entry.includes("time_to_first_token_ms="),
			),
		);
		assert.isFalse(logs.some((entry) => entry.includes("prompt-secret-value")));
		assert.isFalse(
			logs.some((entry) => entry.includes("response-secret-value")),
		);
	});

	it("uses explicit mode without breakpoints while preserving flattened auxiliary prompts", async () => {
		let request: ProviderChatArgs | undefined;
		__setProviderOverrideForTests("openai", async (args) => {
			request = args;
			return {
				content: "value: accepted",
				usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
				reasoning_tokens: "",
			};
		});

		await chatYAML<{ value: string }>(
			[
				{ role: "system", content: "AUXILIARY SYSTEM" },
				{ role: "user", content: "AUXILIARY PAYLOAD" },
			],
			{ provider: "openai", model: "gpt-5.6-luna" },
			"auxiliary-no-cache-test",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				promptCacheOptions: { mode: "explicit", ttl: "30m" },
			},
		);

		assert.deepEqual(request?.openAIPromptCache, {
			promptCacheOptions: { mode: "explicit", ttl: "30m" },
		});
		assert.isUndefined(request?.openAIInputMessages);
		assert.include(request?.prompt ?? "", "SYSTEM:\nAUXILIARY SYSTEM");
		assert.include(request?.prompt ?? "", "USER:\nAUXILIARY PAYLOAD");
		assert.isTrue(
			logs.some(
				(entry) =>
					entry.includes("event=request_start") &&
					entry.includes('prompt_cache_mode="explicit"'),
			),
		);
	});

	it("attributes slow-request heartbeats to the active provider phase", async () => {
		process.env[STALL_LOG_INTERVAL_MS_ENV] = "10";
		__setProviderOverrideForTests("openai", async (args) => {
			await new Promise((resolve) => setTimeout(resolve, 15));
			args.onLifecycleEvent?.({
				type: "first_delta",
				deltaType: "reasoning",
			});
			await new Promise((resolve) => setTimeout(resolve, 15));
			args.onLifecycleEvent?.({ type: "first_text_delta" });
			await new Promise((resolve) => setTimeout(resolve, 15));
			args.onLifecycleEvent?.({
				type: "text_stream_complete",
				chunkCount: 1,
				outputCharacters: 8,
			});
			await new Promise((resolve) => setTimeout(resolve, 15));
			args.onLifecycleEvent?.({ type: "usage_complete" });
			return {
				content: "value: 1",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
				},
				reasoning_tokens: "",
			};
		});

		await chatYAML<{ value: number }>(
			[{ role: "user", content: "test" }],
			{ provider: "openai", model: "gpt-test" },
			"heartbeat-test",
		);

		const heartbeats = logs.filter((entry) =>
			entry.includes("event=heartbeat"),
		);
		assert.isTrue(
			heartbeats.some((entry) =>
				entry.includes('phase="awaiting_first_token"'),
			),
		);
		assert.isTrue(
			heartbeats.some((entry) => entry.includes('phase="streaming"')),
		);
		assert.isTrue(
			heartbeats.some((entry) => entry.includes('phase="awaiting_usage"')),
		);
	});

	it("logs the YAML repair strategy without logging response content", async () => {
		__setProviderOverrideForTests("openai", async () => ({
			content: "text: Result: accepted\ndone: true",
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
			},
			reasoning_tokens: "",
		}));

		const result = await chatYAML<{ text: string; done: boolean }>(
			[{ role: "user", content: "test" }],
			{ provider: "openai", model: "gpt-test" },
			"repair-diagnostics-test",
		);

		assert.strictEqual(result.data.text, "Result: accepted");
		assert.isTrue(
			logs.some(
				(entry) =>
					entry.includes("event=parse_complete") &&
					entry.includes('repair="unquoted_scalars"'),
			),
		);
		assert.isFalse(logs.some((entry) => entry.includes("Result: accepted")));
	});

	it("logs advisory-field salvage as a distinct parse repair", async () => {
		__setProviderOverrideForTests("openai", async () => ({
			content: `previousStepStatus: progressed
previousStepOutcome: "Opened details
currentStateObservation: "Visible result
nextActionRationale: "Return result
tools: []
done: true`,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
			},
			reasoning_tokens: "",
		}));

		const result = await chatYAML<{ done: boolean }>(
			[{ role: "user", content: "test" }],
			{ provider: "openai", model: "gpt-test" },
			"advisory-repair-diagnostics-test",
		);

		assert.isTrue(result.data.done);
		assert.isTrue(
			logs.some(
				(entry) =>
					entry.includes("event=parse_complete") &&
					entry.includes('repair="advisory_fields"'),
			),
		);
	});
});
