import { assert } from "chai";
import { describe, it } from "mocha";
import {
	__runTaskRetryLoopForTests,
	buildExtractionStepUsage,
	buildRecapStageUsage,
	buildRunTaskRunResult,
	buildTokenUsageArtifactAttempt,
	getTaskRunRetryDelayMs,
} from "../src/core/run-task.js";
import type {
	MainLoopStepEntry,
	StageModelInvocationTrace,
} from "../src/agents/types.js";
import type { RunAgentResult } from "../src/core/types.js";

describe("runTask retry loop", () => {
	it("preserves raw YAML and successful validator output", () => {
		const result = buildRunTaskRunResult(2, {
			result: "- name: Example",
			completed: true,
			successful: true,
			successVerification: {
				success: true,
				summary: "Verified.",
			},
		} as RunAgentResult);

		assert.deepEqual(result, {
			runIndex: 2,
			result: "- name: Example",
			completed: true,
			successful: true,
			validator: {
				ran: true,
				success: true,
				summary: "Verified.",
			},
		});
	});

	it("preserves rejected validator output", () => {
		const result = buildRunTaskRunResult(1, {
			result: "answer: incomplete",
			completed: true,
			successful: false,
			successVerification: {
				success: false,
				summary: "Missing evidence.",
			},
		} as RunAgentResult);

		assert.deepEqual(result.validator, {
			ran: true,
			success: false,
			summary: "Missing evidence.",
		});
	});

	it("marks validation as not run for incomplete runs", () => {
		const result = buildRunTaskRunResult(1, {
			result: null,
			completed: false,
			successful: false,
		} as RunAgentResult);

		assert.deepEqual(result.validator, {
			ran: false,
			success: false,
			summary: "Validation did not run.",
		});
	});

	it("selects ordered preprocessing and verification recap stages", () => {
		const createTrace = (
			stage: string,
			meta?: Record<string, unknown>,
			usage: StageModelInvocationTrace["usage"] = {
				input_tokens: 10,
				output_tokens: 2,
				total_tokens: 12,
			},
		): StageModelInvocationTrace => ({
			step_kind: "stage_llm",
			stage,
			attempt: 1,
			caller: stage,
			provider: "openai",
			model: "gpt-test",
			messages: [],
			usage,
			reasoning_tokens: "",
			meta,
		});

		assert.deepEqual(
			buildRecapStageUsage([
				createTrace("findTargetURL"),
				createTrace("createChecklist", {
					phase: "initial_checklist",
					checklistAttempt: 1,
				}),
				createTrace("runAgent"),
				createTrace("dataExtraction"),
				createTrace("verifySuccess"),
				{
					...createTrace("verifySuccess"),
					usage: undefined,
				},
			]),
			[
				{
					phase: "preprocess",
					stage: "findTargetURL",
					usage: {
						input_tokens: 10,
						output_tokens: 2,
						total_tokens: 12,
					},
				},
				{
					phase: "preprocess",
					stage: "createChecklist",
					usage: {
						input_tokens: 10,
						output_tokens: 2,
						total_tokens: 12,
					},
				},
				{
					phase: "verification",
					stage: "verifySuccess",
					usage: {
						input_tokens: 10,
						output_tokens: 2,
						total_tokens: 12,
					},
				},
				{
					phase: "verification",
					stage: "verifySuccess",
					usage: undefined,
				},
			],
		);
	});

	it("maps extraction traces to executor recap rows across auth rows", () => {
		const mainLoopEntries: MainLoopStepEntry[] = [
			{ step: 1, step_kind: "executor_step", messages: [] },
			{ step: 2, step_kind: "auth_takeover_attempt", messages: [] },
			{ step: 3, step_kind: "executor_step", messages: [] },
		];
		const createTrace = (
			stage: string,
			step: unknown,
			usage: StageModelInvocationTrace["usage"],
		): StageModelInvocationTrace => ({
			step_kind: "stage_llm",
			stage,
			attempt: 1,
			caller: stage,
			provider: "openai",
			model: "gpt-test",
			messages: [],
			usage,
			reasoning_tokens: "",
			meta: { step },
		});
		const firstUsage = {
			input_tokens: 10,
			output_tokens: 2,
			total_tokens: 12,
			generation_time_ms: 100,
		};
		const secondUsage = {
			input_tokens: 20,
			output_tokens: 3,
			total_tokens: 23,
			generation_time_ms: 200,
		};

		const result = buildExtractionStepUsage({
			mainLoopEntries,
			modelInvocations: [
				createTrace("dataExtraction", 2, firstUsage),
				createTrace("verifySuccess", 2, secondUsage),
				createTrace("dataExtraction", "2", secondUsage),
				createTrace("dataExtraction", 2, undefined),
				createTrace("dataExtraction", 2, secondUsage),
			],
		});

		assert.deepEqual(result, [
			{ parentStep: 3, extractionIndex: 1, usage: firstUsage },
			{ parentStep: 3, extractionIndex: 2, usage: secondUsage },
		]);
	});

	it("builds ordered all-stage token usage artifacts", () => {
		const usage = (input: number, output: number) => ({
			input_tokens: input,
			output_tokens: output,
			total_tokens: input + output,
		});
		const trace = (
			stage: string,
			input: number,
			meta?: Record<string, unknown>,
		): StageModelInvocationTrace => ({
			step_kind: "stage_llm",
			stage,
			attempt: 1,
			caller: stage,
			provider: "openai",
			model: "stage-model",
			messages: [{ secret: "must-not-be-persisted" }],
			usage: usage(input, 1),
			reasoning_tokens: "must-not-be-persisted",
			meta,
		});
		const result = buildTokenUsageArtifactAttempt({
			runIndex: 1,
			retryAttempt: 2,
			completed: true,
			successful: true,
			mainLoopEntries: [
				{ step: 1, step_kind: "executor_step", messages: [] },
				{ step: 2, step_kind: "auth_takeover_attempt", messages: [] },
				{ step: 3, step_kind: "executor_step", messages: [] },
			],
			stepTokenUsage: [
				{ step: 1, ...usage(10, 2) },
				{
					step: 2,
					...usage(20, 3),
					cached_input_tokens: 5,
					reasoning_tokens: 1,
					non_reasoning_output_tokens: 2,
				},
				{
					step: 3,
					...usage(30, 4),
					reasoning_tokens: 2,
					non_reasoning_output_tokens: 2,
				},
			],
			modelInvocations: [
				trace("findTargetURL", 1),
				trace("dataExtraction", 4, { step: 2 }),
				trace("createChecklist", 5, {
					phase: "checklist_regeneration",
					stepNumber: 2,
				}),
				trace("futureStage", 7),
				trace("verifySuccess", 6),
			],
			runAgentProvider: "openai",
			runAgentModel: "executor-model",
		});

		assert.deepEqual(
			result.invocations.map((invocation) => ({
				sequence: invocation.sequence,
				stage: invocation.stage,
				step: invocation.step,
				stepKind: invocation.stepKind,
			})),
			[
				{
					sequence: 1,
					stage: "findTargetURL",
					step: undefined,
					stepKind: undefined,
				},
				{
					sequence: 2,
					stage: "runAgent",
					step: 1,
					stepKind: "executor_step",
				},
				{
					sequence: 3,
					stage: "authTakeover",
					step: 2,
					stepKind: "auth_takeover_attempt",
				},
				{
					sequence: 4,
					stage: "runAgent",
					step: 3,
					stepKind: "executor_step",
				},
				{
					sequence: 5,
					stage: "dataExtraction",
					step: 3,
					stepKind: undefined,
				},
				{
					sequence: 6,
					stage: "createChecklist",
					step: 3,
					stepKind: undefined,
				},
				{
					sequence: 7,
					stage: "futureStage",
					step: undefined,
					stepKind: undefined,
				},
				{
					sequence: 8,
					stage: "verifySuccess",
					step: undefined,
					stepKind: undefined,
				},
			],
		);
		assert.deepEqual(result.totals, {
			input_tokens: 83,
			cached_input_tokens: 5,
			reasoning_tokens: 3,
			non_reasoning_output_tokens: 11,
			output_tokens: 14,
			total_tokens: 97,
			generation_time_ms: 0,
		});
		assert.notInclude(JSON.stringify(result), "must-not-be-persisted");
	});

	it("uses 1s, 3s, then 8s outer retry delays", () => {
		assert.strictEqual(getTaskRunRetryDelayMs(1), 1000);
		assert.strictEqual(getTaskRunRetryDelayMs(2), 3000);
		assert.strictEqual(getTaskRunRetryDelayMs(3), 8000);
		assert.strictEqual(getTaskRunRetryDelayMs(4), 8000);
	});

	it("continues to later runs after an earlier run exhausts retries", async () => {
		const attempts: Array<{ runIndex: number; attemptOrdinal: number }> = [];
		const sleepCalls: number[] = [];

		const failedRuns = await __runTaskRetryLoopForTests({
			taskRuns: 3,
			taskRunRetryCount: 2,
			sleepFn: async (ms) => {
				sleepCalls.push(ms);
			},
			executeRun: async (runIndex, attemptOrdinal) => {
				attempts.push({ runIndex, attemptOrdinal });
				if (runIndex === 1) {
					throw new Error(`run-${runIndex}-attempt-${attemptOrdinal}`);
				}
				return { status: "success" };
			},
		});

		assert.deepEqual(attempts, [
			{ runIndex: 1, attemptOrdinal: 1 },
			{ runIndex: 1, attemptOrdinal: 2 },
			{ runIndex: 1, attemptOrdinal: 3 },
			{ runIndex: 2, attemptOrdinal: 1 },
			{ runIndex: 3, attemptOrdinal: 1 },
		]);
		assert.deepEqual(sleepCalls, [1000, 3000]);
		assert.lengthOf(failedRuns, 1);
		assert.strictEqual(failedRuns[0]?.runIndex, 1);
		assert.strictEqual(failedRuns[0]?.kind, "runtime_exception");
		assert.lengthOf(failedRuns[0]?.errors ?? [], 3);
		assert.include(failedRuns[0]?.errors[0] ?? "", "Error: run-1-attempt-1");
		assert.include(failedRuns[0]?.errors[1] ?? "", "Error: run-1-attempt-2");
		assert.include(failedRuns[0]?.errors[2] ?? "", "Error: run-1-attempt-3");
	});

	it("does not retry terminal run failures that already produced a verdict", async () => {
		const attempts: Array<{ runIndex: number; attemptOrdinal: number }> = [];
		const sleepCalls: number[] = [];

		const failedRuns = await __runTaskRetryLoopForTests({
			taskRuns: 3,
			taskRunRetryCount: 2,
			sleepFn: async (ms) => {
				sleepCalls.push(ms);
			},
			executeRun: async (runIndex, attemptOrdinal) => {
				attempts.push({ runIndex, attemptOrdinal });
				if (runIndex === 1) {
					return {
						status: "failed",
						message: "run-1-terminal-failure",
					};
				}
				return { status: "success" };
			},
		});

		assert.deepEqual(attempts, [
			{ runIndex: 1, attemptOrdinal: 1 },
			{ runIndex: 2, attemptOrdinal: 1 },
			{ runIndex: 3, attemptOrdinal: 1 },
		]);
		assert.deepEqual(sleepCalls, []);
		assert.lengthOf(failedRuns, 1);
		assert.strictEqual(failedRuns[0]?.runIndex, 1);
		assert.strictEqual(failedRuns[0]?.kind, "terminal_run_failure");
		assert.deepEqual(failedRuns[0]?.errors, ["run-1-terminal-failure"]);
	});

	it("stops after the first success when retry-until-success mode is enabled", async () => {
		const attempts: Array<{ runIndex: number; attemptOrdinal: number }> = [];

		const failedRuns = await __runTaskRetryLoopForTests({
			taskRuns: 4,
			taskRunRetryCount: 0,
			stopOnFirstSuccess: true,
			executeRun: async (runIndex, attemptOrdinal) => {
				attempts.push({ runIndex, attemptOrdinal });
				if (runIndex < 3) {
					return {
						status: "failed",
						message: `run-${runIndex}-terminal-failure`,
					};
				}
				return { status: "success" };
			},
		});

		assert.deepEqual(attempts, [
			{ runIndex: 1, attemptOrdinal: 1 },
			{ runIndex: 2, attemptOrdinal: 1 },
			{ runIndex: 3, attemptOrdinal: 1 },
		]);
		assert.lengthOf(failedRuns, 2);
		assert.deepEqual(
			failedRuns.map((run) => run.runIndex),
			[1, 2],
		);
	});
});
