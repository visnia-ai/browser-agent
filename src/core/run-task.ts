import { configFeatureFlags } from "../config-feature-flags.js";
import type {
	ExtractionStepUsage,
	MainLoopStepEntry,
	RecapStageUsage,
	StageModelInvocationTrace,
	StepTokenUsage,
	SuccessVerificationResult,
	TokenUsage,
} from "../agents/types.js";
import { buildRunTaskScopedFileRoots } from "./run-task-file-roots.js";
import { runAgent } from "./run-agent.js";
import type {
	RunFailureRecord,
	RunAgentResult,
	RunTaskInput,
	RunTaskResult,
	RunTaskRunResult,
	StepRuntimeMetrics,
	TokenUsageArtifactAttempt,
	TokenUsageArtifactInvocation,
	TokenUsageTotals,
} from "./types.js";
import { findTaskExecutionOverride } from "./task-execution-overrides.js";

const OUTER_TASK_RETRY_DELAYS_MS = [1000, 3000, 8000];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRunTaskErrorMessage(error: unknown): string {
	return error instanceof Error ? error.stack || error.message : String(error);
}

export function getTaskRunRetryDelayMs(retryNumber: number): number {
	if (retryNumber <= 0) {
		return 0;
	}
	return (
		OUTER_TASK_RETRY_DELAYS_MS[retryNumber - 1] ??
		OUTER_TASK_RETRY_DELAYS_MS[OUTER_TASK_RETRY_DELAYS_MS.length - 1]
	);
}

export function buildRunTaskRunResult(
	runIndex: number,
	result: RunAgentResult,
): RunTaskRunResult {
	return {
		runIndex,
		result: result.result,
		completed: result.completed,
		successful: result.successful,
		validator: result.successVerification
			? {
					ran: true,
					success: result.successVerification.success,
					summary: result.successVerification.summary,
				}
			: {
					ran: false,
					success: false,
					summary: "Validation did not run.",
				},
	};
}

type RunAttemptExecutionResult =
	| { status: "success" }
	| {
			status: "failed";
			message: string;
	  };

interface FinalExecutionReport {
	result: string;
	steps: number;
	tokenUsage: StepTokenUsage[];
	stepRuntimeMetrics: StepRuntimeMetrics[];
	extractionStepUsage: ExtractionStepUsage[];
	stageUsage: RecapStageUsage[];
	successful: boolean;
	successVerification?: SuccessVerificationResult;
}

const PREPROCESS_RECAP_STAGES = new Set([
	"findTargetURL",
]);

export function buildRecapStageUsage(
	modelInvocations: StageModelInvocationTrace[],
): RecapStageUsage[] {
	const stageUsage: RecapStageUsage[] = [];
	for (const trace of modelInvocations) {
		if (
			PREPROCESS_RECAP_STAGES.has(trace.stage) ||
			(trace.stage === "createChecklist" &&
				trace.meta?.phase === "initial_checklist")
		) {
			stageUsage.push({
				phase: "preprocess",
				stage: trace.stage,
				usage: trace.usage,
			});
		} else if (trace.stage === "verifySuccess") {
			stageUsage.push({
				phase: "verification",
				stage: trace.stage,
				usage: trace.usage,
			});
		}
	}
	return stageUsage;
}

export function buildExtractionStepUsage(params: {
	modelInvocations: StageModelInvocationTrace[];
	mainLoopEntries: MainLoopStepEntry[];
}): ExtractionStepUsage[] {
	const recapStepByExecutorStep = new Map<number, number>();
	let executorStep = 0;
	for (const entry of params.mainLoopEntries) {
		if (entry.step_kind === "auth_takeover_attempt") continue;
		executorStep += 1;
		recapStepByExecutorStep.set(executorStep, entry.step);
	}

	const extractionCountByParent = new Map<number, number>();
	const extractionStepUsage: ExtractionStepUsage[] = [];
	for (const trace of params.modelInvocations) {
		if (trace.stage !== "dataExtraction" || !trace.usage) continue;
		const sourceStep = trace.meta?.step;
		if (
			typeof sourceStep !== "number" ||
			!Number.isInteger(sourceStep) ||
			sourceStep < 1
		) {
			continue;
		}
		const parentStep = recapStepByExecutorStep.get(sourceStep);
		if (typeof parentStep !== "number") continue;
		const extractionIndex = (extractionCountByParent.get(parentStep) ?? 0) + 1;
		extractionCountByParent.set(parentStep, extractionIndex);
		extractionStepUsage.push({
			parentStep,
			extractionIndex,
			usage: trace.usage,
		});
	}

	return extractionStepUsage;
}

function copyTokenUsage(usage: TokenUsage | StepTokenUsage): TokenUsage {
	const copied: TokenUsage = {
		input_tokens: usage.input_tokens,
		output_tokens: usage.output_tokens,
		total_tokens: usage.total_tokens,
	};
	if (typeof usage.cached_input_tokens === "number") {
		copied.cached_input_tokens = usage.cached_input_tokens;
	}
	if (typeof usage.cache_write_tokens === "number") {
		copied.cache_write_tokens = usage.cache_write_tokens;
	}
	if (typeof usage.reasoning_tokens === "number") {
		copied.reasoning_tokens = usage.reasoning_tokens;
	}
	if (typeof usage.non_reasoning_output_tokens === "number") {
		copied.non_reasoning_output_tokens = usage.non_reasoning_output_tokens;
	}
	if (
		"time_to_first_token_ms" in usage &&
		typeof usage.time_to_first_token_ms === "number"
	) {
		copied.time_to_first_token_ms = usage.time_to_first_token_ms;
	}
	if (
		"generation_time_ms" in usage &&
		typeof usage.generation_time_ms === "number"
	) {
		copied.generation_time_ms = usage.generation_time_ms;
	}
	return copied;
}

export function sumTokenUsageInvocations(
	invocations: TokenUsageArtifactInvocation[],
): TokenUsageTotals {
	return invocations.reduce<TokenUsageTotals>(
		(totals, invocation) => {
			const usage = invocation.usage;
			if (!usage) return totals;
			const hasOutputBreakdown =
				"reasoning_tokens" in usage || "non_reasoning_output_tokens" in usage;
			totals.input_tokens += usage.input_tokens;
			totals.cached_input_tokens += usage.cached_input_tokens ?? 0;
			totals.cache_write_tokens += usage.cache_write_tokens ?? 0;
			totals.reasoning_tokens += usage.reasoning_tokens ?? 0;
			totals.non_reasoning_output_tokens += hasOutputBreakdown
				? (usage.non_reasoning_output_tokens ?? 0)
				: usage.output_tokens;
			totals.output_tokens += usage.output_tokens;
			totals.total_tokens += usage.total_tokens;
			totals.generation_time_ms += usage.generation_time_ms ?? 0;
			return totals;
		},
		{
			input_tokens: 0,
			cached_input_tokens: 0,
			cache_write_tokens: 0,
			reasoning_tokens: 0,
			non_reasoning_output_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
			generation_time_ms: 0,
		},
	);
}

function getTokenUsageStagePhase(
	trace: StageModelInvocationTrace,
): TokenUsageArtifactInvocation["phase"] {
	if (trace.stage === "verifySuccess") return "verification";
	if (PREPROCESS_RECAP_STAGES.has(trace.stage)) {
		return "preprocess";
	}
	if (
		trace.stage === "dataExtraction" ||
		typeof trace.meta?.step === "number" ||
		typeof trace.meta?.stepNumber === "number"
	) {
		return "executor";
	}
	return "other";
}

export function buildTokenUsageArtifactAttempt(params: {
	runIndex: number;
	retryAttempt: number;
	completed: boolean;
	successful: boolean;
	stepTokenUsage: StepTokenUsage[];
	mainLoopEntries: MainLoopStepEntry[];
	modelInvocations: StageModelInvocationTrace[];
	runAgentProvider: RunTaskInput["stageLLMs"]["runAgent"]["provider"];
	runAgentModel: string;
}): TokenUsageArtifactAttempt {
	const recapStepByExecutorStep = new Map<number, number>();
	let executorStep = 0;
	for (const entry of params.mainLoopEntries) {
		if (entry.step_kind === "auth_takeover_attempt") continue;
		executorStep += 1;
		recapStepByExecutorStep.set(executorStep, entry.step);
	}
	const stepKindByStep = new Map(
		params.mainLoopEntries.map((entry) => [entry.step, entry.step_kind]),
	);

	const stageRows = params.modelInvocations.map((trace, index) => {
		const phase = getTokenUsageStagePhase(trace);
		const sourceStep =
			typeof trace.meta?.step === "number"
				? trace.meta.step
				: typeof trace.meta?.stepNumber === "number"
					? trace.meta.stepNumber
					: undefined;
		const step =
			phase === "executor" && typeof sourceStep === "number"
				? (recapStepByExecutorStep.get(sourceStep) ?? sourceStep)
				: undefined;
		return {
			index,
			row: {
				sequence: 0,
				kind: "stage",
				phase,
				stage: trace.stage,
				provider: trace.provider,
				model: trace.model,
				...(typeof step === "number" ? { step } : {}),
				modelAttempt: trace.attempt,
				usage: trace.usage ? copyTokenUsage(trace.usage) : null,
			} satisfies TokenUsageArtifactInvocation,
		};
	});

	const ordered: TokenUsageArtifactInvocation[] = [];
	const consumedStageIndexes = new Set<number>();
	for (const stage of stageRows) {
		if (stage.row.phase !== "preprocess") continue;
		ordered.push(stage.row);
		consumedStageIndexes.add(stage.index);
	}
	for (const stepUsage of params.stepTokenUsage) {
		const stepKind = stepKindByStep.get(stepUsage.step);
		ordered.push({
			sequence: 0,
			kind: "executor_step",
			phase: "executor",
			stage: stepKind === "auth_takeover_attempt" ? "authTakeover" : "runAgent",
			provider: params.runAgentProvider,
			model: params.runAgentModel,
			step: stepUsage.step,
			...(stepKind ? { stepKind } : {}),
			usage: copyTokenUsage(stepUsage),
		});
		for (const stage of stageRows) {
			if (stage.row.step !== stepUsage.step) continue;
			ordered.push(stage.row);
			consumedStageIndexes.add(stage.index);
		}
	}
	for (const stage of stageRows) {
		if (
			consumedStageIndexes.has(stage.index) ||
			stage.row.phase === "verification"
		) {
			continue;
		}
		ordered.push(stage.row);
		consumedStageIndexes.add(stage.index);
	}
	for (const stage of stageRows) {
		if (stage.row.phase !== "verification") continue;
		ordered.push(stage.row);
	}
	const invocations = ordered.map((invocation, index) => ({
		...invocation,
		sequence: index + 1,
	}));
	return {
		runIndex: params.runIndex,
		retryAttempt: params.retryAttempt,
		completed: params.completed,
		successful: params.successful,
		invocations,
		totals: sumTokenUsageInvocations(invocations),
	};
}

interface RunTaskRetryLoopInput {
	taskRuns: number;
	taskRunRetryCount: number;
	stopOnFirstSuccess?: boolean;
	executeRun: (
		runIndex: number,
		attemptOrdinal: number,
	) => Promise<RunAttemptExecutionResult>;
	sleepFn?: (ms: number) => Promise<void>;
	onRetry?: (input: {
		runIndex: number;
		retryNumber: number;
		maxRetries: number;
		message: string;
	}) => void;
	onRunFailure?: (input: {
		runIndex: number;
		attemptsUsed: number;
		totalAttempts: number;
		message: string;
		errors: string[];
	}) => void;
}

export async function __runTaskRetryLoopForTests(
	input: RunTaskRetryLoopInput,
): Promise<RunFailureRecord[]> {
	const failedRuns: RunFailureRecord[] = [];
	const sleepFn = input.sleepFn ?? sleep;

	for (let runIndex = 1; runIndex <= input.taskRuns; runIndex++) {
		let attempt = 0;
		const runErrors: string[] = [];

		while (true) {
			const attemptOrdinal = attempt + 1;
			try {
				const runResult = await input.executeRun(runIndex, attemptOrdinal);
				if (runResult.status === "failed") {
					failedRuns.push({
						runIndex,
						errors: [runResult.message],
						kind: "terminal_run_failure",
					});
				}
				if (runResult.status === "success" && input.stopOnFirstSuccess) {
					return failedRuns;
				}
				break;
			} catch (error) {
				const message = toRunTaskErrorMessage(error);
				runErrors.push(message);

				if (attempt >= input.taskRunRetryCount) {
					failedRuns.push({
						runIndex,
						errors: [...runErrors],
						kind: "runtime_exception",
					});
					input.onRunFailure?.({
						runIndex,
						attemptsUsed: attemptOrdinal,
						totalAttempts: input.taskRunRetryCount + 1,
						message,
						errors: [...runErrors],
					});
					break;
				}

				attempt += 1;
				input.onRetry?.({
					runIndex,
					retryNumber: attempt,
					maxRetries: input.taskRunRetryCount,
					message,
				});
				await sleepFn(getTaskRunRetryDelayMs(attempt));
			}
		}
	}

	return failedRuns;
}

export async function runTask(input: RunTaskInput): Promise<RunTaskResult> {
	const totalRunAttempts = input.taskUntilSuccessMaxAttempts ?? input.taskRuns;
	const stopOnFirstSuccess =
		totalRunAttempts > 1 && !!input.taskUntilSuccessMaxAttempts;
	const runLabel = stopOnFirstSuccess ? "Attempt" : "Run";
	const finalExecutionReportRef: { current: FinalExecutionReport | null } = {
		current: null,
	};
	const runResults: RunTaskResult["runs"] = [];
	const failedTokenUsageAttemptByRun = new Map<
		number,
		TokenUsageArtifactAttempt
	>();

	console.log(`\n[TASK ${input.taskNumber}/${input.totalTasks}] ${input.task}`);
	if (stopOnFirstSuccess) {
		console.log(
			`Retrying failed task attempts until first success (max ${totalRunAttempts} attempts).`,
		);
	} else if (input.taskRuns > 1) {
		console.log(`Running this task ${input.taskRuns} times.`);
	}

	const failedRuns = await __runTaskRetryLoopForTests({
		taskRuns: totalRunAttempts,
		taskRunRetryCount: input.taskRunRetryCount,
		stopOnFirstSuccess,
		sleepFn: sleep,
		onRetry: ({ runIndex, retryNumber, maxRetries, message }) => {
			console.error(
				`[TASK ${input.taskNumber}] ${runLabel} ${runIndex}/${totalRunAttempts} failed (retry ${retryNumber}/${maxRetries}): ${message}`,
			);
		},
		onRunFailure: ({ runIndex, attemptsUsed, totalAttempts, message }) => {
			const tokenUsageAttempt = failedTokenUsageAttemptByRun.get(runIndex);
			if (tokenUsageAttempt) {
				input.persistence.saveTokenUsageAttempt?.(tokenUsageAttempt);
				failedTokenUsageAttemptByRun.delete(runIndex);
			}
			console.error(
				`[TASK ${input.taskNumber}] ${runLabel} ${runIndex}/${totalRunAttempts} failed after ${attemptsUsed}/${totalAttempts} attempts: ${message}${
					runIndex < totalRunAttempts
						? ` Continuing to next ${runLabel.toLowerCase()}.`
						: ""
				}`,
			);
		},
		executeRun: async (runIndex, attemptOrdinal) => {
			const attempt = attemptOrdinal - 1;
			const modelInvocations: StageModelInvocationTrace[] = [];
			const observedStepTokenUsage: StepTokenUsage[] = [];
			const recordModelInvocation = (
				trace: StageModelInvocationTrace,
			): void => {
				modelInvocations.push({
					...trace,
					meta: {
						...(trace.meta ?? {}),
						run: runIndex,
						totalRuns: totalRunAttempts,
						attempt: attemptOrdinal,
						totalAttempts: input.taskRunRetryCount + 1,
					},
				});
			};
			if (totalRunAttempts > 1) {
				console.log(
					`\n[TASK ${input.taskNumber}] ${runLabel} ${runIndex}/${totalRunAttempts}`,
				);
			}
			const taskExecutionOverride = findTaskExecutionOverride(
				input.taskExecutionOverrides,
				input.task,
			);
			if (taskExecutionOverride?.url) {
				console.log(
					`[TASK ${input.taskNumber}] Using provided start URL override: ${taskExecutionOverride.url}`,
				);
			}
			console.log(
				`[Worker ${input.browserLaunch.workerId}] Launching fresh browser${
					input.browserLaunch.port ? ` on port ${input.browserLaunch.port}` : ""
				} for task ${input.taskNumber}, ${runLabel.toLowerCase()} ${runIndex}/${totalRunAttempts}, attempt ${attemptOrdinal}/${input.taskRunRetryCount + 1}...`,
			);
			const scopedFileRoots = buildRunTaskScopedFileRoots({
				downloadDir: input.browserLaunch.downloadDir,
				fileWorkspaceRoot: input.browserLaunch.fileWorkspaceRoot,
				taskNumber: input.taskNumber,
				runIndex,
				attemptOrdinal,
			});

			const trajectoryStartedAt = performance.now();
			let runAgentResult: RunAgentResult;
			try {
				runAgentResult = await runAgent({
					session: {
						port: input.browserLaunch.port ?? 9222,
						headless: input.browserLaunch.headless,
						downloadDir: scopedFileRoots.downloadDir,
						downloadRootDir: scopedFileRoots.downloadRootDir,
						fileWorkspaceRoot: scopedFileRoots.fileWorkspaceRoot,
						userDataDir: input.browserLaunch.userDataDir,
						executablePath: input.browserLaunch.executablePath,
						proxy: input.browserLaunch.proxy,
						url: taskExecutionOverride?.url ?? input.browserLaunch.url,
						forceRestart: true,
					},
					task: input.task,
					stageLLMs: input.stageLLMs,
					featureFlags: configFeatureFlags,
					promptCacheShard: `worker-${input.browserLaunch.workerId}`,
					autoSwitchToNewTab: true,
					requestAuthDomainCandidates: input.requestAuthDomainCandidates,
					requestAuthIdentifierForDomain: input.requestAuthIdentifierForDomain,
					requestAuthPasswordForDomain: input.requestAuthPasswordForDomain,
					onUserActionRequired: input.onUserActionRequired,
					recordModelInvocation,
					onStepGenerated: ({ stepNumber, usage }) => {
						observedStepTokenUsage.push({
							step: stepNumber,
							input_tokens: usage.input_tokens,
							cached_input_tokens: usage.cached_input_tokens,
							cache_write_tokens: usage.cache_write_tokens,
							reasoning_tokens: usage.reasoning_tokens,
							non_reasoning_output_tokens: usage.non_reasoning_output_tokens,
							output_tokens: usage.output_tokens,
							total_tokens: usage.total_tokens,
						});
					},
					maxSteps: input.maxSteps,
					validatorLifecycle: input.validatorLifecycle,
					onPreprocessedTask: async ({ preprocess }) => {
						console.log(`Target: ${preprocess.target_url}`);
					},
				});
			} catch (error) {
				failedTokenUsageAttemptByRun.set(
					runIndex,
					buildTokenUsageArtifactAttempt({
						runIndex,
						retryAttempt: attemptOrdinal,
						completed: false,
						successful: false,
						stepTokenUsage: observedStepTokenUsage,
						mainLoopEntries: observedStepTokenUsage.map((usage) => ({
							step: usage.step,
							step_kind: "executor_step",
							messages: [],
						})),
						modelInvocations,
						runAgentProvider: input.stageLLMs.runAgent.provider,
						runAgentModel: input.stageLLMs.runAgent.model,
					}),
				);
				throw error;
			}
			const durationMs = Math.round(performance.now() - trajectoryStartedAt);

			const finalResult = runAgentResult.completed
				? (runAgentResult.result ?? "(done=true with no result text)")
				: "[Agent reached max steps without completing the task]";
			const displayResult = runAgentResult.completed
				? finalResult
				: runAgentResult.userActionRequired
					? `[User takeover required: ${runAgentResult.userActionRequired.reason}]`
					: finalResult;
			const jsonlEntry = {
				task: input.task,
				durationMs,
				steps: runAgentResult.mainLoopEntries,
				completed: runAgentResult.completed,
				successful: runAgentResult.successful,
				finalResult: runAgentResult.completed ? finalResult : null,
				...(runAgentResult.successVerification
					? {
							successVerification: runAgentResult.successVerification,
						}
					: {}),
				browserEquivalentSteps: runAgentResult.mainLoopEntries.length,
				trajectoryDurationMs: durationMs,
				stepRuntimeMetrics: runAgentResult.stepRuntimeMetrics,
				executorTokenTotals: runAgentResult.tokenTotals,
				pageObservationMetrics:
					runAgentResult.pageObservationMetrics,
				pageObservationEvents:
					runAgentResult.pageObservationEvents,
				executionOverrides: {
					pageObservationMode:
						runAgentResult.pageObservationMetrics.mode,
					url: !!taskExecutionOverride?.url,
					metadata: taskExecutionOverride?.metadata,
				},
			};

			input.persistence.appendJsonlEntry(
				totalRunAttempts === 1
					? {
							...jsonlEntry,
							modelInvocations,
						}
					: {
							...jsonlEntry,
							modelInvocations,
							run: runIndex,
							totalRuns: totalRunAttempts,
						},
				runIndex,
			);
			failedTokenUsageAttemptByRun.delete(runIndex);
			input.persistence.saveTokenUsageAttempt?.(
				buildTokenUsageArtifactAttempt({
					runIndex,
					retryAttempt: attemptOrdinal,
					completed: runAgentResult.completed,
					successful: runAgentResult.successful,
					stepTokenUsage: runAgentResult.stepTokenUsage,
					mainLoopEntries: runAgentResult.mainLoopEntries,
					modelInvocations,
					runAgentProvider: input.stageLLMs.runAgent.provider,
					runAgentModel: input.stageLLMs.runAgent.model,
				}),
			);
			finalExecutionReportRef.current = {
				result: displayResult,
				steps: runAgentResult.mainLoopEntries.length,
				tokenUsage: runAgentResult.stepTokenUsage,
				stepRuntimeMetrics: runAgentResult.stepRuntimeMetrics,
				extractionStepUsage: buildExtractionStepUsage({
					modelInvocations,
					mainLoopEntries: runAgentResult.mainLoopEntries,
				}),
				stageUsage: buildRecapStageUsage(modelInvocations),
				successful: jsonlEntry.successful,
				successVerification: jsonlEntry.successVerification,
			};
			runResults.push(buildRunTaskRunResult(runIndex, runAgentResult));

			if (!jsonlEntry.completed) {
				const userActionRequired = runAgentResult.userActionRequired;
				if (userActionRequired) {
					return {
						status: "failed",
						message: `User action required: ${userActionRequired.reason}`,
					};
				}
				return {
					status: "failed",
					message: `Task did not complete within ${input.maxSteps} step(s).`,
				};
			}

			if (!jsonlEntry.successful) {
				const summary =
					jsonlEntry.successVerification?.summary ||
					"Task finished with done=true but failed success verification.";
				const reasons = jsonlEntry.successVerification?.reasons ?? [];
				return {
					status: "failed",
					message:
						reasons.length > 0
							? `${summary} Reasons: ${reasons.join(" | ")}`
							: summary,
				};
			}

			return { status: "success" };
		},
	});

	const report = finalExecutionReportRef.current;
	if (report !== null) {
		input.persistence.reportSingleRunExecution?.(
			report.result,
			report.steps,
			report.tokenUsage,
			report.successful,
			report.successVerification,
			report.stepRuntimeMetrics,
			report.extractionStepUsage,
			report.stageUsage,
		);
	}

	return {
		failedRuns,
		runtimeFailedRuns: failedRuns.filter(
			(run) => run.kind === "runtime_exception",
		),
		terminalFailedRuns: failedRuns.filter(
			(run) => run.kind === "terminal_run_failure",
		),
		runs: runResults,
	};
}
