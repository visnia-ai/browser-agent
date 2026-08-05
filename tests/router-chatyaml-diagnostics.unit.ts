import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { chatYAML } from "../src/agents/providers/router.js";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";

const STALL_LOG_INTERVAL_MS_ENV =
	"BROWSER_AGENT_CHAT_YAML_STALL_LOG_INTERVAL_MS";

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

	it("logs lifecycle milestones, records TTFT, and omits prompt and response content", async () => {
		__setProviderOverrideForTests("openai", async (args) => {
			args.onLifecycleEvent?.({
				type: "first_delta",
				deltaType: "reasoning",
			});
			args.onLifecycleEvent?.({ type: "first_text_delta" });
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
		assert.isNumber(result.usage.time_to_first_token_ms);
		const events = logs.filter((entry) => entry.includes("[LLM][chatYAML]"));
		const eventIndex = (event: string) =>
			events.findIndex((entry) => entry.includes(`event=${event}`));
		assert.isAtLeast(eventIndex("request_start"), 0);
		assert.isAbove(eventIndex("first_delta"), eventIndex("request_start"));
		assert.isAbove(eventIndex("first_text_delta"), eventIndex("first_delta"));
		assert.isAbove(
			eventIndex("text_stream_complete"),
			eventIndex("first_text_delta"),
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
