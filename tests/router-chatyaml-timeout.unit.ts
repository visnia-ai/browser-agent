import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { chatYAML } from "../src/agents/providers/router.js";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";
import type { Message } from "../src/agents/types.js";

const HARD_TIMEOUT_MS_ENV = "BROWSER_AGENT_CHAT_YAML_HARD_TIMEOUT_MS";

describe("router chatYAML timeout", () => {
	afterEach(() => {
		__setProviderOverrideForTests("openai", null);
		__setProviderOverrideForTests("vllm", null);
		delete process.env[HARD_TIMEOUT_MS_ENV];
	});

	it("retries hard-timed-out calls and eventually succeeds", async () => {
		process.env[HARD_TIMEOUT_MS_ENV] = "20";
		const logs: string[] = [];
		const originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		};

		let streamAttempt = 0;
		__setProviderOverrideForTests("openai", async (args) => {
			streamAttempt += 1;
			const signal = args.abortSignal;
			if (!signal) {
				throw new Error("missing signal");
			}

			if (streamAttempt <= 2) {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() =>
							reject(
								new Error(`attempt-${streamAttempt}-aborted`),
							),
						{ once: true },
					);
				});
			}
			return {
				content: "state: ok",
				usage: {
					input_tokens: 2,
					output_tokens: 3,
					total_tokens: 5,
				},
				reasoning_tokens: "",
			};
		});

		try {
			const messages: Message[] = [{ role: "user", content: "test" }];
			const result = await chatYAML<{ state: string }>(
				messages,
				{
					provider: "openai",
					model: "gpt-5.2-mini",
				},
				"router-timeout-test",
			);

			assert.strictEqual(result.data.state, "ok");
			assert.strictEqual(streamAttempt, 3);
		} finally {
			console.log = originalConsoleLog;
		}
		assert.strictEqual(
			logs.filter((entry) => entry.includes("event=hard_timeout")).length,
			2,
		);
		assert.strictEqual(
			logs.filter((entry) => entry.includes("event=retry_backoff")).length,
			2,
		);
		assert.isTrue(
			logs.some(
				(entry) =>
					entry.includes("event=operation_complete") &&
					entry.includes("attempts=3"),
			),
		);
	});

	it("always uses streaming for OpenAI chatYAML", async () => {
		let createCalls = 0;
		__setProviderOverrideForTests("openai", async (args) => {
			createCalls += 1;
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

		const result = await chatYAML<{ value: number }>(
			[{ role: "user", content: "test" }],
			{
				provider: "openai",
				model: "gpt-5.2-mini",
			},
			"router-stream-openai",
		);

		assert.strictEqual(result.data.value, 1);
		assert.strictEqual(createCalls, 1);
	});

	it("always uses streaming for vLLM chatYAML", async () => {
		let createCalls = 0;
		__setProviderOverrideForTests("vllm", async (args) => {
			createCalls += 1;
			return {
				content: "value: 2",
				usage: {
					input_tokens: 1,
					output_tokens: 2,
					total_tokens: 3,
				},
				reasoning_tokens: "",
			};
		});

		const result = await chatYAML<{ value: number }>(
			[{ role: "user", content: "test" }],
			{
				provider: "vllm",
				model: "mock-vllm",
			},
			"router-stream-vllm",
		);

		assert.strictEqual(result.data.value, 2);
		assert.strictEqual(createCalls, 1);
	});

	it("applies a hard timeout to provider calls that never resolve", async function () {
		this.timeout(15000);
		process.env[HARD_TIMEOUT_MS_ENV] = "20";
		let createCalls = 0;
		__setProviderOverrideForTests("vllm", async () => {
			createCalls += 1;
			return await new Promise<never>(() => {});
		});

		try {
			await chatYAML<{ value: number }>(
				[{ role: "user", content: "test" }],
				{
					provider: "vllm",
					model: "mock-vllm",
				},
				"router-hard-timeout-vllm",
			);
			assert.fail("Expected chatYAML to time out");
		} catch (error) {
			assert.include(String(error), "chatYAML hard timeout");
			assert.include(String(error), "router-hard-timeout-vllm");
		}

		assert.strictEqual(createCalls, 5);
	});
});
