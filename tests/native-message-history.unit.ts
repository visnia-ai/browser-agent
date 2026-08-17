import { assert } from "chai";
import { describe, it } from "mocha";
import {
	NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
	OPENAI_EXECUTOR_CONTEXT_POLICY,
} from "../src/agents/executor-context-policy.js";
import { buildStepMessages } from "../src/agents/executor-utils/step-execution.js";
import { stripPayloadForHistory } from "../src/agents/executor-utils/history-payload.js";
import { buildHistoryMessagesFromFullStepHistory } from "../src/core/history-adapter.js";
import type { StepHistoryEntry } from "../src/core/types.js";

describe("native model-message history", () => {
	const reasoningPart = {
		type: "reasoning" as const,
		text: "preserved reasoning",
		providerOptions: {
			anthropic: { signature: "signed-reasoning" },
		},
	};

	function historyEntry(): StepHistoryEntry {
		return {
			payload: { currentURL: "https://example.com/current" },
			assistant: "tools:\n  - click: r2\ndone: false\n",
			responseMessages: [
				{
					role: "assistant",
					providerOptions: { anthropic: { container: "session-1" } },
					content: [
						reasoningPart,
						{
							type: "text",
							text: "previousStepStatus: blocked\nunsafe raw response",
							providerOptions: {
								openai: { itemId: "stale-text-item" },
								google: { thoughtSignature: "google-text-signature" },
							},
						},
					],
				},
			],
		};
	}

	for (const [name, executorContextPolicy] of [
		["OpenAI", OPENAI_EXECUTOR_CONTEXT_POLICY],
		["non-OpenAI", NON_OPENAI_EXECUTOR_CONTEXT_POLICY],
	] as const) {
		it(`preserves native reasoning metadata for ${name} history`, () => {
			const messages = buildHistoryMessagesFromFullStepHistory(
				[historyEntry()],
				{ executorContextPolicy },
			);
			assert.lengthOf(messages, 2);
			const assistant = messages[1];
			assert.strictEqual(assistant?.role, "assistant");
			assert.isArray(assistant?.content);
			if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
				throw new Error("expected structured assistant history");
			}
			assert.deepEqual(assistant.content[0], reasoningPart);
			assert.deepEqual(assistant.content[1], {
				type: "text",
				text: "tools:\n  - click: r2\ndone: false\n",
				providerOptions: {
					google: { thoughtSignature: "google-text-signature" },
				},
			});
			assert.deepEqual(assistant.providerOptions, {
				anthropic: { container: "session-1" },
			});
			assert.notInclude(JSON.stringify(assistant), "unsafe raw response");
			assert.notInclude(JSON.stringify(assistant), "stale-text-item");
		});
	}

	it("interleaves cleaned user turns with every accepted native response message", () => {
		const entry = historyEntry();
		entry.responseMessages.push({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "tool-1",
					toolName: "example",
					output: { type: "text", value: "ok" },
				},
			],
		});
		const messages = buildHistoryMessagesFromFullStepHistory([entry]);
		assert.deepEqual(
			messages.map((message) => message.role),
			["user", "assistant", "tool"],
		);
		assert.include(String(messages[0]?.content), "currentURL");
	});

	for (const mode of ["current", "cumulative"] as const) {
		it(`keeps three-step ${mode} history aligned with native reasoning`, () => {
			const rawPayloads = [1, 2].map((step) => ({
				task: "browser task",
				currentDateTime: `stale-time-${step}`,
				currentURL: `https://example.com/${step}`,
				projectionContextMode: step === 1 ? "reset" : "delta",
				projection: `STALE_DOM_${step} button ref=\"r${step}\"`,
				validRefs: [`r${step}`],
				memoryContent: `STALE_MEMORY_${step}`,
				authContext: { usernameOrEmail: `stale-user-${step}@example.com` },
				currentPageScreenshotIncludedAsImagePart: true,
				openTabs: [`STALE_TAB_${step}`],
			}));
			const history: StepHistoryEntry[] = rawPayloads.map((payload, index) => ({
				payload: stripPayloadForHistory({
					payload,
					cumulativeProjectionHistoryEnabled: mode === "cumulative",
					projectionContextMode: index === 0 ? "reset" : "delta",
				}),
				assistant: `tools:\n  - click: r${index + 1}\ndone: false\n`,
				responseMessages: [
					{
						role: "assistant",
						content: [
							{
								type: "reasoning",
								text: `reasoning-${index + 1}`,
								providerOptions: {
									anthropic: { signature: `signature-${index + 1}` },
								},
							},
							{ type: "text", text: `raw-response-${index + 1}` },
						],
					},
				],
			}));

			const messages = buildStepMessages({
				systemPrompt: "system",
				history: buildHistoryMessagesFromFullStepHistory(history),
				payload: {
					currentURL: "https://example.com/3",
					projection: 'CURRENT_DOM button ref="r3"',
					memoryContent: "CURRENT_MEMORY",
				},
				currentPageScreenshotDataUrl: "data:image/jpeg;base64,Q1VSUkVOVA==",
			});

			assert.deepEqual(
				messages.map((message) => message.role),
				["system", "user", "assistant", "user", "assistant", "user"],
			);
			const serialized = JSON.stringify(messages);
			assert.include(serialized, "reasoning-1");
			assert.include(serialized, "signature-1");
			assert.include(serialized, "reasoning-2");
			assert.include(serialized, "signature-2");
			assert.notInclude(serialized, "raw-response-1");
			assert.notInclude(serialized, "raw-response-2");
			assert.include(serialized, "CURRENT_DOM");
			assert.include(serialized, "Q1VSUkVOVA==");

			if (mode === "current") {
				for (const stale of [
					"STALE_DOM_1",
					"STALE_DOM_2",
					"STALE_MEMORY_1",
					"STALE_MEMORY_2",
					"stale-user-1@example.com",
					"stale-user-2@example.com",
					"STALE_TAB_1",
					"STALE_TAB_2",
				]) {
					assert.notInclude(serialized, stale);
				}
			} else {
				assert.include(serialized, "STALE_DOM_1");
				assert.include(serialized, "STALE_DOM_2");
				assert.include(serialized, "STALE_MEMORY_1");
				assert.include(serialized, "stale-user-2@example.com");
			}
		});
	}
});
