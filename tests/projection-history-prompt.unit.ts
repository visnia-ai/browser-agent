import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { configFeatureFlags } from "../src/config-feature-flags.js";
import {
	closeSession,
	createPromptForStep,
	createSession,
	processModelOutputAndBrowse,
	step,
} from "../src/core/index.js";
import type { StepHistoryEntry } from "../src/core/types.js";
import { createMockCoreDeps } from "./helpers/core-deps-fixtures.js";

function makeProjection(changingText: string): string {
	return [
		"main: Stable page",
		...Array.from(
			{ length: 100 },
			(_, index) => `  section: Stable content ${index}`,
		),
		`  button ref="1": ${changingText}`,
	].join("\n");
}

describe("cumulative semantic projection context", () => {
	const originalFlag = configFeatureFlags.semanticProjectionHistory;

	afterEach(() => {
		configFeatureFlags.semanticProjectionHistory = originalFlag;
	});

	it("chains deltas and emits empty unchanged deltas without ordinary rebases", async () => {
		configFeatureFlags.semanticProjectionHistory = "cumulative";
		let currentProjection = makeProjection("Old");
		let executedProjection: string | undefined;
		const deps = createMockCoreDeps({
			getPageProjection: async () => currentProjection,
			executeActions: async (params) => {
				executedProjection = params.pageProjection;
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
				};
			},
		});
		const port = 9551;
		const stepsHistory: StepHistoryEntry[] = [];
		await createSession(deps, { port, headless: true });

		try {
			const first = await createPromptForStep(deps, {
				port,
				userTask: "Test cumulative semantic projection",
				stepsHistory,
				stepNumber: 1,
			});
			assert.strictEqual(first.prompt.payload.projectionContextMode, "reset");
			assert.strictEqual(first.prompt.payload.projection, currentProjection);
			await step(deps, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [] },
				promptPayload: first.prompt.payload,
				stepsHistory,
			});

			currentProjection = makeProjection("New");
			const second = await createPromptForStep(deps, {
				port,
				userTask: "Test cumulative semantic projection",
				stepsHistory,
				stepNumber: 2,
			});
			assert.strictEqual(second.prompt.payload.projectionContextMode, "delta");
			assert.include(String(second.prompt.payload.projection), "-  button");
			assert.include(String(second.prompt.payload.projection), "+  button");
			const retriedSecond = await createPromptForStep(deps, {
				port,
				userTask: "Test cumulative semantic projection",
				stepsHistory,
				stepNumber: 2,
			});
			assert.strictEqual(
				retriedSecond.prompt.payload.projectionContextMode,
				"delta",
			);
			assert.strictEqual(
				retriedSecond.prompt.payload.projection,
				second.prompt.payload.projection,
			);
			await processModelOutputAndBrowse(deps, port, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [{ wait: 1 }] },
				promptPayload: retriedSecond.prompt.payload,
				stepsHistory,
			});
			assert.strictEqual(executedProjection, currentProjection);

			const third = await createPromptForStep(deps, {
				port,
				userTask: "Test cumulative semantic projection",
				stepsHistory,
				stepNumber: 3,
			});
			assert.strictEqual(third.prompt.payload.projectionContextMode, "delta");
			assert.strictEqual(third.prompt.payload.projection, "");
			await step(deps, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [] },
				promptPayload: third.prompt.payload,
				stepsHistory,
			});

			currentProjection = 'dialog ref="9": Completely different';
			const fourth = await createPromptForStep(deps, {
				port,
				userTask: "Test cumulative semantic projection",
				stepsHistory,
				stepNumber: 4,
			});
			assert.strictEqual(fourth.prompt.payload.projectionContextMode, "delta");
			assert.include(
				String(fourth.prompt.payload.projection),
				"Completely different",
			);
			const fourthMessages = JSON.stringify(fourth.prompt.messages);
			assert.include(fourthMessages, "Stable content 0");
			assert.include(fourthMessages, "tools");

			await step(deps, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [] },
				promptPayload: fourth.prompt.payload,
				stepsHistory,
			});
			for (const entry of stepsHistory.slice(0, -1)) {
				assert.property(entry.payload, "projection");
				assert.property(entry.payload, "projectionContextMode");
			}
			assert.strictEqual(
				stepsHistory.at(-1)?.payload.projectionContextMode,
				"delta",
			);
			assert.include(
				String(stepsHistory.at(-1)?.payload.projection),
				"Completely different",
			);
		} finally {
			await closeSession(deps, port);
		}
	});

	it("preserves current-only projection behavior when cumulative history is disabled", async () => {
		configFeatureFlags.semanticProjectionHistory = "current";
		const deps = createMockCoreDeps();
		const port = 9552;
		const stepsHistory: StepHistoryEntry[] = [];
		await createSession(deps, { port, headless: true });

		try {
			const prompt = await createPromptForStep(deps, {
				port,
				userTask: "Current-only behavior",
				stepsHistory,
				llmOptions: {
					provider: "vllm",
					model: "test-model",
					reasoningEffort: "none",
				},
			});
			assert.notProperty(prompt.prompt.payload, "projectionContextMode");
			assert.strictEqual(
				prompt.prompt.payload.projection,
				'projection semantic-v1 refs=2\ndocument ref="r1" name="Example"\n  button ref="r2" name="Continue"',
			);
			await step(deps, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [] },
				promptPayload: prompt.prompt.payload,
				stepsHistory,
			});
			assert.notProperty(stepsHistory[0].payload, "projection");
		} finally {
			await closeSession(deps, port);
		}
	});

	it("honors the configured projection history for an encrypted OpenAI executor", async () => {
		configFeatureFlags.semanticProjectionHistory = "current";
		let currentProjection = "document: Old projection";
		const deps = createMockCoreDeps({
			getPageProjection: async () => currentProjection,
		});
		const port = 9553;
		const stepsHistory: StepHistoryEntry[] = [];
		await createSession(deps, { port, headless: true });

		try {
			const current = await createPromptForStep(deps, {
				port,
				userTask: "Current OpenAI projection history",
				stepsHistory,
				llmOptions: {
					provider: "openai",
					model: "gpt-test",
					reasoningEffort: "none",
				},
			});
			assert.notProperty(current.prompt.payload, "projectionContextMode");
			assert.equal(current.prompt.payload.projection, currentProjection);
			await step(deps, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [] },
				promptPayload: current.prompt.payload,
				stepsHistory,
			});

			currentProjection = "document: New projection";
			const nextCurrent = await createPromptForStep(deps, {
				port,
				userTask: "Current OpenAI projection history",
				stepsHistory,
				llmOptions: {
					provider: "openai",
					model: "gpt-test",
					reasoningEffort: "none",
				},
			});
			assert.notProperty(nextCurrent.prompt.payload, "projectionContextMode");
			assert.equal(nextCurrent.prompt.payload.projection, currentProjection);
			assert.notInclude(
				JSON.stringify(nextCurrent.prompt.messages),
				"Old projection",
			);

			configFeatureFlags.semanticProjectionHistory = "cumulative";
			const cumulative = await createPromptForStep(deps, {
				port,
				userTask: "Cumulative OpenAI projection history",
				stepsHistory,
				llmOptions: {
					provider: "openai",
					model: "gpt-test",
					reasoningEffort: "none",
				},
			});
			assert.equal(cumulative.prompt.payload.projectionContextMode, "reset");
		} finally {
			await closeSession(deps, port);
		}
	});
});
