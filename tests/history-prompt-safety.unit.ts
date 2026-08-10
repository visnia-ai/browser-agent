import { assert } from "chai";
import { describe, it } from "mocha";
import { stripPayloadForHistory } from "../src/agents/executor-utils/history-payload.js";
import {
	NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
	OPENAI_EXECUTOR_CONTEXT_POLICY,
} from "../src/agents/executor-context-policy.js";
import { configFeatureFlags } from "../src/config-feature-flags.js";
import { buildHistoryMessagesFromFullStepHistory } from "../src/core/history-adapter.js";
import { toCompletionPrompt } from "../src/agents/providers/message-serialization.js";

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
		const messages = buildHistoryMessagesFromFullStepHistory([
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
		]);

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
		const messages = buildHistoryMessagesFromFullStepHistory([
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
		]);
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
			[
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
			],
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

	it("includes reasoning tokens as assistant message fields when enabled", () => {
		const originalCumulativeProjectionHistory =
			configFeatureFlags.semanticProjectionHistory;
		const stepsHistory = [
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
				reasoningTokens: "Inspect page:\nstatus: ready",
			},
		];

		try {
			for (const projectionHistory of ["current", "cumulative"] as const) {
				configFeatureFlags.semanticProjectionHistory = projectionHistory;
				const messages = buildHistoryMessagesFromFullStepHistory(
					stepsHistory,
					{ executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY },
				);
					const assistant = messages[1];
					const assistantContent = String(assistant.content);
					assert.strictEqual(
						assistant.reasoning_tokens,
						"Inspect page:\nstatus: ready",
					);
					assert.notInclude(assistantContent, "<think>");
					assert.notInclude(assistantContent, "Inspect page:");
					assert.include(assistantContent, "previousStepStatus");
					assert.include(assistantContent, "nextActionRationale");
					assert.include(assistantContent, "type: click");
					assert.include(assistantContent, "done: false");
					assert.notInclude(assistantContent, "result:");

					const completionPrompt = toCompletionPrompt(messages);
					assert.include(completionPrompt, "reasoning_tokens: |-\n");
					assert.include(completionPrompt, "  Inspect page:");
					assert.include(completionPrompt, "previousStepStatus:");
			}
		} finally {
			configFeatureFlags.semanticProjectionHistory =
				originalCumulativeProjectionHistory;
		}
	});

	it("omits reasoning tokens when disabled or empty", () => {
		const historyEntry = {
			payload: { currentURL: "https://example.com" },
			assistant: { actions: [], done: false },
			reasoningTokens: "reasoning trace",
		};

		const disabled = buildHistoryMessagesFromFullStepHistory(
			[historyEntry],
			{ executorContextPolicy: NON_OPENAI_EXECUTOR_CONTEXT_POLICY },
		);
			assert.notProperty(disabled[1], "reasoning_tokens");
			assert.notInclude(toCompletionPrompt(disabled), "reasoning_tokens:");

			const empty = buildHistoryMessagesFromFullStepHistory([
				{ ...historyEntry, reasoningTokens: "  \n " },
			], { executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY });
			assert.notProperty(empty[1], "reasoning_tokens");
			assert.notInclude(toCompletionPrompt(empty), "reasoning_tokens:");
	});
});
