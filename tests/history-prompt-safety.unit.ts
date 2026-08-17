import { assert } from "chai";
import { describe, it } from "mocha";
import { stripPayloadForHistory } from "../src/agents/executor-utils/history-payload.js";
import { NON_OPENAI_EXECUTOR_CONTEXT_POLICY } from "../src/agents/executor-context-policy.js";
import { configFeatureFlags } from "../src/config-feature-flags.js";
import { buildHistoryMessagesFromFullStepHistory } from "../src/core/history-adapter.js";
import type { StepHistoryEntry } from "../src/core/types.js";

function withNativeResponses(
	steps: Array<Omit<StepHistoryEntry, "responseMessages">>,
): StepHistoryEntry[] {
	return steps.map((step) => ({
		...step,
		responseMessages: [{ role: "assistant", content: "raw response" }],
	}));
}

describe("history prompt safety", () => {
	it("strips prompt-only payload fields and legacy plans", () => {
		const payload = {
			task: "Log in safely",
			plan: ["Step 1"],
			currentURL: "https://example.com",
			projection: "<div>dom</div>",
			validRefs: ["1"],
			interactionErrors: ["x"],
			latestUserPromptTokenCount: 10,
			currentTab: 0,
			openTabs: ["Home"],
			newlyOpenedTabs: ["New"],
			downloadedFiles: ["a.pdf"],
			workspaceFiles: ["./downloads/a.pdf"],
			autoTabSwitchNote: "note",
			currentPageScreenshotIncludedAsImagePart: true,
			previousAction: "click",
			memoryAvailable: "Prepared context is available.",
			memoryContent: "Sensitive scratchpad content",
			authContext: {
				usernameOrEmail: "user@example.com",
			},
		};

		assert.deepEqual(stripPayloadForHistory({ payload }), {
			currentURL: "https://example.com",
		});
	});

	it("retains the exact prior payload for cumulative cache prefixes", () => {
		const originalCumulativeProjectionHistory =
			configFeatureFlags.semanticProjectionHistory;
		configFeatureFlags.semanticProjectionHistory = "cumulative";
		try {
			const stepsHistory = [
				{
					payload: {
						currentURL: "https://example.com/old",
						projectionContextMode: "reset",
						projection: "old anchor",
					},
					assistant: {},
					responseMessages: [],
				},
			];
			const stripped = stripPayloadForHistory({
				payload: {
					task: "task",
					currentURL: "https://example.com/new",
					projectionContextMode: "delta",
					projection: "@@ diff",
					memoryContent: "private memory",
					authContext: { usernameOrEmail: "private@example.com" },
				},
				cumulativeProjectionHistoryEnabled: true,
				projectionContextMode: "delta",
				stepsHistory,
			});

			assert.deepEqual(stripped, {
				task: "task",
				currentURL: "https://example.com/new",
				projectionContextMode: "delta",
				projection: "@@ diff",
				memoryContent: "private memory",
				authContext: { usernameOrEmail: "private@example.com" },
			});
			assert.strictEqual(stepsHistory[0].payload.projection, "old anchor");
		} finally {
			configFeatureFlags.semanticProjectionHistory =
				originalCumulativeProjectionHistory;
		}
	});

	it("preserves accepted model assistant outputs without action normalization", () => {
		const messages = buildHistoryMessagesFromFullStepHistory(
			withNativeResponses([
				{
					payload: {
						currentURL: "https://example.com/login",
					},
					assistant: "plain string assistant",
				},
				{
					payload: {
						currentURL: "https://example.com/form",
					},
					assistant: {
						custom: "object assistant",
					},
				},
				{
					payload: {
						currentURL: "https://example.com/list",
					},
					assistant: ["array assistant"],
				},
				{
					payload: {
						currentURL: "https://example.com/app",
					},
					assistant: {
						thinking: "Continue",
						tools: [{ click: "1" }],
						done: false,
						result: { ok: true },
						previousStepPlanUpdate: ["Updated"],
					},
				},
				{
					payload: {
						currentURL: "https://example.com/only-tools",
					},
					assistant: {
						tools: [{ click: "3" }],
					},
				},
				{
					payload: {
						currentURL: "https://example.com/only-actions",
					},
					assistant: {
						actions: [{ type: "click", ref: "4" }],
						done: "not-a-boolean",
					},
				},
				{
					payload: {
						currentURL: "https://example.com/only-result",
					},
					assistant: {
						result: "Only result",
					},
				},
				{
					payload: {
						currentURL: "https://example.com/only-plan-update",
					},
					assistant: {
						previousStepPlanUpdate: ["Only update"],
					},
				},
				{
					payload: {
						currentURL: "https://example.com/final",
					},
					assistant: {
						thinking: "Done",
						actions: [{ type: "click", ref: "2" }],
						done: true,
						result: "Finished",
					},
				},
			]),
		);

		assert.lengthOf(messages, 18);
		assert.strictEqual(messages[0].role, "user");
		assert.include(String(messages[0].content), "currentURL");
		assert.strictEqual(messages[1].role, "assistant");
		assert.strictEqual(messages[1].content, "plain string assistant");
		assert.strictEqual(messages[3].role, "assistant");
		assert.include(String(messages[3].content), "custom: object assistant");
		assert.strictEqual(messages[5].role, "assistant");
		assert.include(String(messages[5].content), "- array assistant");
		assert.strictEqual(messages[7].role, "assistant");
		assert.include(String(messages[7].content), "thinking: Continue");
		assert.include(String(messages[7].content), "tools:");
		assert.include(String(messages[7].content), "Updated");
		assert.include(String(messages[7].content), "ok: true");
		assert.include(String(messages[7].content), "done: false");
		assert.strictEqual(messages[9].role, "assistant");
		assert.include(String(messages[9].content), "click:");
		assert.notInclude(String(messages[9].content), "type: click");
		assert.strictEqual(messages[11].role, "assistant");
		assert.include(String(messages[11].content), "actions:");
		assert.include(String(messages[11].content), "type: click");
		assert.include(String(messages[11].content), "done: not-a-boolean");
		assert.strictEqual(messages[13].role, "assistant");
		assert.include(String(messages[13].content), "Only result");
		assert.strictEqual(messages[15].role, "assistant");
		assert.include(String(messages[15].content), "Only update");
		assert.strictEqual(messages[17].role, "assistant");
		assert.include(String(messages[17].content), "Finished");
		assert.include(String(messages[17].content), "type: click");
		assert.include(String(messages[17].content), "thinking: Done");
		assert.include(String(messages[17].content), "done: true");
		assert.include(String(messages[17].content), "result: Finished");
	});

	it("preserves model-emitted action-context fields regardless of execution flags", () => {
		const messages = buildHistoryMessagesFromFullStepHistory(
			withNativeResponses([
				{
					payload: {
						currentURL: "https://example.com/final",
					},
					assistant: {
						previousStepStatus: "opened_tab",
						previousStepOutcome: "Opened Gmail sign-in tab.",
						currentStateObservation:
							"Current tab is still the Workspace landing page.",
						nextActionRationale: "Switch to the Gmail tab to continue login.",
						actions: [{ type: "switch_tab", index: 1 }],
						done: false,
					},
				},
			]),
		);
		assert.strictEqual(messages[1].role, "assistant");
		for (const field of [
			"previousStepStatus",
			"previousStepOutcome",
			"currentStateObservation",
			"nextActionRationale",
		]) {
			assert.include(String(messages[1].content), field);
		}
		assert.include(String(messages[1].content), "type: switch_tab");
		assert.notInclude(String(messages[1].content), "thinking:");
		assert.include(String(messages[1].content), "done: false");
		assert.notInclude(String(messages[1].content), "result:");
	});

	it("preserves every model-emitted field when action context is enabled", () => {
		const messages = buildHistoryMessagesFromFullStepHistory(
			withNativeResponses([
				{
					payload: {
						currentURL: "https://example.com/final",
					},
					assistant: {
						thinking: "Done",
						previousStepStatus: "progressed",
						previousStepOutcome: "Clicked the result.",
						currentStateObservation: "The result page is open.",
						nextActionRationale: "Read the result page.",
						actions: [{ type: "click", ref: "2" }],
						done: true,
						result: "Finished",
					},
				},
			]),
			{ executorContextPolicy: NON_OPENAI_EXECUTOR_CONTEXT_POLICY },
		);
		assert.strictEqual(messages[1].role, "assistant");
		assert.include(String(messages[1].content), "thinking: Done");
		assert.include(
			String(messages[1].content),
			"previousStepStatus: progressed",
		);
		assert.include(
			String(messages[1].content),
			"previousStepOutcome: Clicked the result.",
		);
		assert.include(
			String(messages[1].content),
			"currentStateObservation: The result page is open.",
		);
		assert.include(
			String(messages[1].content),
			"nextActionRationale: Read the result page.",
		);
		assert.include(String(messages[1].content), "type: click");
		assert.include(String(messages[1].content), "done: true");
		assert.include(String(messages[1].content), "result: Finished");
	});

	it("preserves native reasoning parts and provider metadata in every history mode", () => {
		const originalCumulativeProjectionHistory =
			configFeatureFlags.semanticProjectionHistory;
		const reasoningPart = {
			type: "reasoning" as const,
			text: "Inspect page:\nstatus: ready",
			providerOptions: {
				anthropic: { signature: "signature-1" },
			},
		};
		const stepsHistory: StepHistoryEntry[] = [
			{
				payload: { currentURL: "https://example.com/results" },
				assistant: {
					previousStepStatus: "progressed",
					previousStepOutcome: "Loaded results.",
					currentStateObservation: "Results are visible.",
					nextActionRationale: "Inspect the first result.",
					actions: [{ type: "click", ref: "2" }],
					done: false,
				},
				responseMessages: [
					{
						role: "assistant",
						content: [
							reasoningPart,
							{ type: "text", text: "raw provider text" },
						],
					},
				],
			},
		];

		try {
			for (const projectionHistory of ["current", "cumulative"] as const) {
				configFeatureFlags.semanticProjectionHistory = projectionHistory;
				const messages = buildHistoryMessagesFromFullStepHistory(stepsHistory);
				const assistant = messages[1];
				assert.strictEqual(assistant?.role, "assistant");
				assert.isArray(assistant?.content);
				if (
					assistant?.role !== "assistant" ||
					!Array.isArray(assistant.content)
				) {
					throw new Error("Expected structured assistant history.");
				}
				assert.deepEqual(assistant.content[0], reasoningPart);
				assert.strictEqual(assistant.content[1]?.type, "text");
				if (assistant.content[1]?.type !== "text") {
					throw new Error("Expected accepted assistant text.");
				}
				assert.include(assistant.content[1].text, "previousStepStatus");
				assert.include(assistant.content[1].text, "nextActionRationale");
				assert.include(assistant.content[1].text, "type: click");
				assert.include(assistant.content[1].text, "done: false");
				assert.notInclude(assistant.content[1].text, "raw provider text");
				assert.notProperty(assistant, "reasoning_tokens");
			}
		} finally {
			configFeatureFlags.semanticProjectionHistory =
				originalCumulativeProjectionHistory;
		}
	});

	it("preserves empty redacted reasoning metadata but does not invent reasoning", () => {
		const withoutReasoning = buildHistoryMessagesFromFullStepHistory([
			{
				payload: { currentURL: "https://example.com" },
				assistant: { actions: [], done: false },
				responseMessages: [
					{ role: "assistant", content: [{ type: "text", text: "raw" }] },
				],
			},
		]);
		assert.isFalse(
			Array.isArray(withoutReasoning[1]?.content) &&
				withoutReasoning[1].content.some((part) => part.type === "reasoning"),
		);

		const redactedReasoning = {
			type: "reasoning" as const,
			text: "",
			providerOptions: {
				anthropic: { redactedData: "encrypted-redacted-thinking" },
			},
		};
		const withRedactedReasoning = buildHistoryMessagesFromFullStepHistory([
			{
				payload: { currentURL: "https://example.com" },
				assistant: { actions: [], done: false },
				responseMessages: [
					{
						role: "assistant",
						content: [redactedReasoning, { type: "text", text: "raw" }],
					},
				],
			},
		]);
		assert.deepEqual(
			Array.isArray(withRedactedReasoning[1]?.content)
				? withRedactedReasoning[1].content[0]
				: undefined,
			redactedReasoning,
		);
	});

	it("excludes reasoning only from non-OpenAI model-visible history", () => {
		const reasoningPart = {
			type: "reasoning" as const,
			text: "private chain of thought",
			providerOptions: {
				openai: { reasoningEncryptedContent: "encrypted-trace" },
			},
		};
		const entry: StepHistoryEntry = {
			payload: { currentURL: "https://example.com" },
			assistant: { actions: [], done: false },
			responseMessages: [
				{
					role: "assistant",
					content: [reasoningPart, { type: "text", text: "raw" }],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "tool-1",
							toolName: "example",
							output: { type: "text", value: "accepted tool output" },
						},
					],
				},
			],
		};

		const messages = buildHistoryMessagesFromFullStepHistory([entry], {
			executorContextPolicy: NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
		});
		const serialized = JSON.stringify(messages);
		assert.notInclude(serialized, "private chain of thought");
		assert.notInclude(serialized, "encrypted-trace");
		assert.include(serialized, "actions");
		assert.include(serialized, "accepted tool output");
		assert.deepEqual(entry.responseMessages[0]?.content, [
			reasoningPart,
			{ type: "text", text: "raw" },
		]);
	});
});
