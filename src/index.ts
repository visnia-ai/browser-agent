import * as fs from "fs";
import * as path from "path";
import * as net from "node:net";
import * as os from "node:os";
import promiseLimit from "promise-limit";
import {
	parseArgs,
	prompt,
	loadConfig,
	reportExecution,
	type Config,
} from "./utils.js";
import { setConfigFeatureFlags } from "./config-feature-flags.js";
import { resetStepsDir, setRuntimeOptions } from "./runtime-options.js";
import { runTask } from "./core/run-task.js";
import type {
	RunTaskInput,
	RunTaskPersistenceCallbacks,
	RunTaskResult,
	TaskTokenUsageArtifact,
	TokenUsageArtifactAttempt,
	TokenUsageTotals,
} from "./core/types.js";
import { createAuthCredentialCallbacksFromInput } from "./auth/crypto.js";
import {
	cleanupWorkerUserDataDirs,
	prepareWorkerUserDataDirs,
} from "./browser/profile.js";
import {
	installTaskLogConsoleTee,
	resetTaskLogsDir,
	withTaskLogContext,
} from "./task-logging.js";
import { createPortAllocator } from "./port-allocation.js";
import { loadTaskExecutionOverrides } from "./core/task-execution-overrides.js";

function appendJsonlEntry(filePath: string, entry: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
}

function sumArtifactAttemptTotals(
	attempts: TokenUsageArtifactAttempt[],
): TokenUsageTotals {
	return attempts.reduce<TokenUsageTotals>(
		(totals, attempt) => {
			totals.input_tokens += attempt.totals.input_tokens;
			totals.cached_input_tokens += attempt.totals.cached_input_tokens;
			totals.cache_write_tokens += attempt.totals.cache_write_tokens ?? 0;
			totals.reasoning_tokens += attempt.totals.reasoning_tokens;
			totals.non_reasoning_output_tokens +=
				attempt.totals.non_reasoning_output_tokens;
			totals.output_tokens += attempt.totals.output_tokens;
			totals.total_tokens += attempt.totals.total_tokens;
			totals.generation_time_ms += attempt.totals.generation_time_ms;
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

export function saveTaskTokenUsageAttempt(params: {
	tokenUsageDir: string;
	taskNumber: number;
	task: string;
	attempt: TokenUsageArtifactAttempt;
}): void {
	fs.mkdirSync(params.tokenUsageDir, { recursive: true });
	const taskLabel = String(params.taskNumber).padStart(3, "0");
	const filePath = path.join(params.tokenUsageDir, `task-${taskLabel}.json`);
	let attempts: TokenUsageArtifactAttempt[] = [];
	if (fs.existsSync(filePath)) {
		const existing = JSON.parse(
			fs.readFileSync(filePath, "utf-8"),
		) as Partial<TaskTokenUsageArtifact>;
		if (
			(existing.schemaVersion !== 1 && existing.schemaVersion !== 2) ||
			existing.taskIndex !== params.taskNumber ||
			!Array.isArray(existing.attempts)
		) {
			throw new Error(`Invalid token usage artifact: ${filePath}`);
		}
		attempts = existing.attempts;
	}
	const existingIndex = attempts.findIndex(
		(attempt) => attempt.runIndex === params.attempt.runIndex,
	);
	if (existingIndex >= 0) {
		attempts[existingIndex] = params.attempt;
	} else {
		attempts.push(params.attempt);
	}
	attempts.sort((left, right) => left.runIndex - right.runIndex);
	const artifact: TaskTokenUsageArtifact = {
		schemaVersion: 2,
		taskIndex: params.taskNumber,
		task: params.task,
		attempts,
		totals: sumArtifactAttemptTotals(attempts),
	};
	const tempPath = `${filePath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(
			tempPath,
			`${JSON.stringify(artifact, null, 2)}\n`,
			"utf-8",
		);
		fs.renameSync(tempPath, filePath);
	} finally {
		if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
	}
}

function createRunTaskPersistence(params: {
	taskNumber: number;
	task: string;
	taskMessagesPath: string;
	tokenUsageDir: string;
}): RunTaskPersistenceCallbacks {
	return {
		appendJsonlEntry: (entry) =>
			appendJsonlEntry(params.taskMessagesPath, entry),
		saveTokenUsageAttempt: (attempt) =>
			saveTaskTokenUsageAttempt({
				tokenUsageDir: params.tokenUsageDir,
				taskNumber: params.taskNumber,
				task: params.task,
				attempt,
			}),
		reportSingleRunExecution: reportExecution,
	};
}

interface ErrorTaskRecord {
	taskIndex: number;
	errors: string[];
}

export interface MainLifecycleCallbacks {
	onUserActionRequired?: (
		input: Parameters<NonNullable<RunTaskInput["onUserActionRequired"]>>[0] & {
			taskId: string;
		},
	) => void | Promise<void>;
	onTaskResult?: (input: {
		taskId: string;
		status: "completed" | "failed";
		runs: RunTaskResult["runs"];
		errors: string[];
	}) => void | Promise<void>;
}

function extractCollectedErrors(error: unknown): string[] {
	if (
		error &&
		typeof error === "object" &&
		Array.isArray((error as { collectedErrors?: unknown }).collectedErrors)
	) {
		return (error as { collectedErrors: unknown[] }).collectedErrors.filter(
			(message): message is string =>
				typeof message === "string" && message.trim().length > 0,
		);
	}
	if (error instanceof Error) {
		const message = error.stack || error.message;
		return message ? [message] : [];
	}
	if (typeof error === "string" && error.trim().length > 0) {
		return [error];
	}
	return [];
}

function createTaskDebugPortAllocator(): ReturnType<
	typeof createPortAllocator
> {
	const configuredMin = Number(process.env.BROWSER_AGENT_DEBUG_PORT_MIN);
	const configuredMax = Number(process.env.BROWSER_AGENT_DEBUG_PORT_MAX);
	const minPort = Number.isInteger(configuredMin) ? configuredMin : undefined;
	const maxPort = Number.isInteger(configuredMax) ? configuredMax : undefined;
	return createPortAllocator({
		...(minPort !== undefined ? { minPort } : {}),
		...(maxPort !== undefined ? { maxPort } : {}),
		isPortInUse: async (port) =>
			await new Promise<boolean>((resolve) => {
				const server = net.createServer();
				server.once("error", (error: NodeJS.ErrnoException) => {
					if (error.code === "EADDRINUSE") {
						resolve(true);
						return;
					}
					resolve(false);
				});
				server.once("listening", () => {
					server.close(() => resolve(false));
				});
				server.listen(port, "127.0.0.1");
			}),
	});
}

export async function main(
	argv: string[] = process.argv,
	loadConfigFn: (configPath: string) => Config = loadConfig,
	runTaskFn: (
		input: Parameters<typeof runTask>[0],
	) => Promise<RunTaskResult> = runTask,
	lifecycle?: MainLifecycleCallbacks,
): Promise<void> {
	const sleep = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));

	const { config: configPath } = parseArgs(argv);
	if (!configPath) {
		throw new Error(
			"Missing config path. Run 'browser-agent --help' for usage.",
		);
	}
	const config = loadConfigFn(configPath);
	setConfigFeatureFlags(config.featureFlags);

	const {
		stageLLMs,
		headless,
		maxSteps,
		validatorLifecycle,
		downloadDir,
		fileWorkspaceRoot,
		executablePath,
		waitBetweenTasksMs,
		taskRuns,
		taskRunRetryCount,
		taskUntilSuccessMaxAttempts,
		tasks: configTasks,
		concurrency,
		authCredentials,
		browserProfiles,
		saveStepsContext,
		saveTaskLogs,
		stepMessagesJsonlPath,
		taskExecutionOverridesPath,
		proxy,
		customTools,
	} = config;
	const taskExecutionOverrides = taskExecutionOverridesPath
		? loadTaskExecutionOverrides(taskExecutionOverridesPath)
		: undefined;
	const taskLogsDir = path.join(
		path.dirname(stepMessagesJsonlPath),
		"task-logs",
	);
	const tokenUsageDir = path.join(
		path.dirname(stepMessagesJsonlPath),
		"tokenUsage",
	);
	let configuredTasks = configTasks;

	setRuntimeOptions({ saveStepsContext, saveTaskLogs });
	resetStepsDir();
	installTaskLogConsoleTee({
		suppressConsoleWhenTaskLogging: saveTaskLogs,
	});
	resetTaskLogsDir(saveTaskLogs, taskLogsDir);

	if (configuredTasks.length === 0) {
		const promptedTask = await prompt(
			"What would you like me to do on the web?\n> ",
		);
		if (!promptedTask) {
			console.log("No task provided.");
			return;
		}
		configuredTasks = [{ task: promptedTask }];
	}
	const completedTasksFile = (() => {
		const parsed = path.parse(stepMessagesJsonlPath);
		return path.join(parsed.dir, `${parsed.name}.completed-tasks.json`);
	})();
	const errorTasksFile = (() => {
		const parsed = path.parse(stepMessagesJsonlPath);
		return path.join(parsed.dir, `${parsed.name}.error-tasks.json`);
	})();
	let completedTaskIndices = new Set<number>();
	if (fs.existsSync(completedTasksFile)) {
		try {
			const raw = JSON.parse(fs.readFileSync(completedTasksFile, "utf-8"));
			if (Array.isArray(raw)) {
				const valid = raw.filter(
					(v) => Number.isInteger(v) && v >= 1 && v <= configuredTasks.length,
				) as number[];
				completedTaskIndices = new Set(valid);
				console.log(
					`Loaded completed task indices from ${completedTasksFile}: [${valid.sort((a, b) => a - b).join(", ")}]`,
				);
			}
		} catch (e: any) {
			console.error(
				`Failed to parse completed tasks file ${completedTasksFile}: ${e.message}. Starting from scratch.`,
			);
			completedTaskIndices = new Set<number>();
		}
	}
	const errorTasksByIndex = new Map<number, string[]>();
	if (fs.existsSync(errorTasksFile)) {
		try {
			const raw = JSON.parse(fs.readFileSync(errorTasksFile, "utf-8"));
			if (Array.isArray(raw)) {
				for (const entry of raw) {
					if (
						Number.isInteger(entry) &&
						entry >= 1 &&
						entry <= configuredTasks.length
					) {
						errorTasksByIndex.set(entry, []);
						continue;
					}
					if (!entry || typeof entry !== "object") continue;
					const rawTaskIndex = (entry as { taskIndex?: unknown }).taskIndex;
					const taskIndex =
						typeof rawTaskIndex === "number" ? rawTaskIndex : Number.NaN;
					const errors = (entry as { errors?: unknown }).errors;
					if (
						!Number.isInteger(taskIndex) ||
						taskIndex < 1 ||
						taskIndex > configuredTasks.length ||
						!Array.isArray(errors)
					) {
						continue;
					}
					errorTasksByIndex.set(
						taskIndex,
						errors.filter(
							(message): message is string =>
								typeof message === "string" && message.trim().length > 0,
						),
					);
				}
				const loadedIndices = [...errorTasksByIndex.keys()].sort(
					(a, b) => a - b,
				);
				console.log(
					`Loaded error task indices from ${errorTasksFile}: [${loadedIndices.join(", ")}]`,
				);
			}
		} catch (e: any) {
			console.error(
				`Failed to parse error tasks file ${errorTasksFile}: ${e.message}. Starting from scratch.`,
			);
			errorTasksByIndex.clear();
		}
	}

	const tasksToRun = configuredTasks
		.map((taskEntry, index) => ({ taskEntry, configIndex: index + 1 }))
		.filter(({ configIndex }) => !completedTaskIndices.has(configIndex));

	if (tasksToRun.length === 0) {
		console.log(
			"No pending tasks to run. All config tasks are already completed.",
		);
		return;
	}

	function persistCompletedTasks(): void {
		const sorted = [...completedTaskIndices].sort((a, b) => a - b);
		fs.mkdirSync(path.dirname(completedTasksFile), { recursive: true });
		fs.writeFileSync(
			completedTasksFile,
			JSON.stringify(sorted, null, 2),
			"utf-8",
		);
	}

	function persistErrorTasks(): void {
		const sorted: ErrorTaskRecord[] = [...errorTasksByIndex.entries()]
			.sort(([left], [right]) => left - right)
			.map(([taskIndex, errors]) => ({ taskIndex, errors }));
		fs.mkdirSync(path.dirname(errorTasksFile), { recursive: true });
		fs.writeFileSync(errorTasksFile, JSON.stringify(sorted, null, 2), "utf-8");
	}

	const activeWorkerCount = Math.min(concurrency, tasksToRun.length);
	const taskDebugPortAllocator = createTaskDebugPortAllocator();

	const stageOptions = stageLLMs;
	console.log(
		`Stage LLMs: ${JSON.stringify({
			findTargetURL: {
				provider: stageOptions.findTargetURL.provider,
				model: stageOptions.findTargetURL.model,
				reasoningEffort: stageOptions.findTargetURL.reasoningEffort,
			},
			createChecklist: {
				provider: stageOptions.createChecklist.provider,
				model: stageOptions.createChecklist.model,
				reasoningEffort: stageOptions.createChecklist.reasoningEffort,
			},
			runAgent: {
				provider: stageOptions.runAgent.provider,
				model: stageOptions.runAgent.model,
				reasoningEffort: stageOptions.runAgent.reasoningEffort,
			},
			dataExtraction: {
				provider: stageOptions.dataExtraction.provider,
				model: stageOptions.dataExtraction.model,
				reasoningEffort: stageOptions.dataExtraction.reasoningEffort,
			},
			verifySuccess: {
				provider: stageOptions.verifySuccess.provider,
				model: stageOptions.verifySuccess.model,
				reasoningEffort: stageOptions.verifySuccess.reasoningEffort,
			},
		})}`,
	);
	console.log(`Headless mode: ${headless}`);
	console.log(`Max steps per task run: ${maxSteps}`);
	console.log(
		`Download directory: ${downloadDir ? path.resolve(downloadDir) : "auto"}`,
	);
	console.log(
		`File workspace root: ${
			fileWorkspaceRoot ? path.resolve(fileWorkspaceRoot) : "disabled"
		}`,
	);
	console.log("Page projection: semantic-v1 (canonical)");
	console.log(`Wait between tasks (ms): ${waitBetweenTasksMs}`);
	console.log(`Task runs per task: ${taskRuns}`);
	console.log(`Task run retry count: ${taskRunRetryCount}`);
	console.log(
		`Task-until-success max attempts: ${taskUntilSuccessMaxAttempts ?? "disabled"}`,
	);
	console.log(`Loaded ${configuredTasks.length} task(s).`);
	console.log(`Pending ${tasksToRun.length} task(s) after resume filter.`);
	console.log(`Save steps/context: ${saveStepsContext}`);
	console.log(`Save task logs: ${saveTaskLogs}`);
	console.log(`Step messages JSONL path: ${stepMessagesJsonlPath}`);
	console.log(`Token usage directory: ${tokenUsageDir}`);
	console.log(
		`Task execution overrides path: ${taskExecutionOverridesPath ?? "disabled"}`,
	);
	if (taskExecutionOverrides) {
		console.log(
			`Loaded task execution overrides for ${taskExecutionOverrides.tasksByExactText.size} task(s).`,
		);
	}
	console.log(`Proxy: ${proxy ? `${proxy.host}:${proxy.port}` : "disabled"}`);
	if (browserProfiles) {
		console.log(
			`Browser profiles: ${browserProfiles.mode} seed=${browserProfiles.seedUserDataDir} root=${browserProfiles.perWorkerUserDataRoot} reuse=${browserProfiles.reuseExistingWorkerProfiles}`,
		);
	} else {
		console.log("Browser profiles: default per-port userDataDir");
	}
	console.log(`Completed tasks file: ${completedTasksFile}`);
	console.log(`Error tasks file: ${errorTasksFile}`);
	console.log(`Concurrency limit: ${activeWorkerCount} browser instance(s).`);

	const availableSlots = Array.from({ length: activeWorkerCount }, (_, i) => i);
	const waiters: Array<(slot: number) => void> = [];

	async function acquireSlot(): Promise<number> {
		if (availableSlots.length > 0) {
			return availableSlots.shift() as number;
		}
		return new Promise((resolve) => {
			waiters.push(resolve);
		});
	}

	function releaseSlot(slot: number): void {
		const waiter = waiters.shift();
		if (waiter) {
			waiter(slot);
			return;
		}
		availableSlots.push(slot);
	}

	const limit = promiseLimit(activeWorkerCount);

	function getTaskMessagesPath(taskNumber: number): string {
		if (configuredTasks.length <= 1) {
			return stepMessagesJsonlPath;
		}
		const parsed = path.parse(stepMessagesJsonlPath);
		const suffix = `-task-${String(taskNumber).padStart(3, "0")}`;
		const ext = parsed.ext || ".jsonl";
		return path.join(parsed.dir, `${parsed.name}${suffix}${ext}`);
	}

	const workerUserDataDirs = prepareWorkerUserDataDirs({
		browserProfiles,
		workers: Array.from({ length: activeWorkerCount }, (_, slot) => ({
			workerId: slot + 1,
		})),
	});
	const workersPromise = Promise.all(
		tasksToRun.map(({ taskEntry, configIndex }) =>
			limit(async () => {
				const slot = await acquireSlot();
				const workerId = slot + 1;
				const taskId = `task-${configIndex}`;
				let port: number | undefined;
				try {
					const task = taskEntry.task;
					const taskAuthCallbacks = createAuthCredentialCallbacksFromInput({
						credentials: taskEntry.authCredentials ?? authCredentials,
						encryptionKey: taskEntry.authEncryptionKey,
					});
					port = await taskDebugPortAllocator.acquirePort();
					const persistence = createRunTaskPersistence({
						taskNumber: configIndex,
						task,
						taskMessagesPath: getTaskMessagesPath(configIndex),
						tokenUsageDir,
					});
					const runTaskResult = await withTaskLogContext(
						configIndex,
						task,
						saveTaskLogs,
						async () =>
							runTaskFn({
								task,
								taskNumber: configIndex,
								totalTasks: configuredTasks.length,
								taskRuns,
								taskRunRetryCount,
								taskUntilSuccessMaxAttempts,
								maxSteps,
								validatorLifecycle,
								stageLLMs,
								requestAuthDomainCandidates:
									taskAuthCallbacks?.requestAuthDomainCandidates,
								requestAuthIdentifierForDomain:
									taskAuthCallbacks?.requestAuthIdentifierForDomain,
								requestAuthPasswordForDomain:
									taskAuthCallbacks?.requestAuthPasswordForDomain,
								onUserActionRequired: lifecycle?.onUserActionRequired
									? async (input) =>
											await lifecycle.onUserActionRequired?.({
												...input,
												taskId,
											})
									: undefined,
								browserLaunch: {
									port: port ?? undefined,
									headless,
									url: taskEntry.url,
									downloadDir,
									fileWorkspaceRoot,
									userDataDir: workerUserDataDirs.get(workerId),
									executablePath,
									proxy,
									workerId,
								},
								persistence,
								taskExecutionOverrides,
								customTools,
							}),
						taskLogsDir,
					);
					await lifecycle?.onTaskResult?.({
						taskId,
						status:
							runTaskResult.failedRuns.length === 0 ? "completed" : "failed",
						runs: runTaskResult.runs,
						errors: runTaskResult.failedRuns.flatMap((run) => run.errors),
					});
					completedTaskIndices.add(configIndex);
					const runtimeErrors = runTaskResult.runtimeFailedRuns.flatMap(
						(run) => run.errors,
					);
					if (runtimeErrors.length > 0) {
						errorTasksByIndex.set(configIndex, runtimeErrors);
					} else {
						errorTasksByIndex.delete(configIndex);
					}
					persistCompletedTasks();
					persistErrorTasks();
				} catch (e: any) {
					const errors = extractCollectedErrors(e);
					errorTasksByIndex.set(configIndex, errors);
					persistErrorTasks();
					await lifecycle?.onTaskResult?.({
						taskId,
						status: "failed",
						runs: [],
						errors,
					});
					console.error(
						`[Worker ${workerId}] Task ${configIndex} failed: ${e.stack || e.message}`,
					);
				} finally {
					if (port !== undefined) {
						taskDebugPortAllocator.releasePort(port);
					}
					if (waitBetweenTasksMs > 0) {
						await sleep(waitBetweenTasksMs);
					}
					releaseSlot(slot);
				}
			}),
		),
	);
	let workerRunFailed = false;
	try {
		await workersPromise;
	} catch (error) {
		workerRunFailed = true;
		throw error;
	} finally {
		const cleanup = cleanupWorkerUserDataDirs({
			browserProfiles,
			workerUserDataDirs,
		});
		if (cleanup.removedDirectories.length > 0) {
			console.log(
				`Browser profiles: cleaned ${cleanup.removedDirectories.length} disposable worker profile(s).`,
			);
		}
		if (cleanup.failures.length > 0) {
			const message = `Browser profile cleanup failed: ${cleanup.failures
				.map((failure) => `${failure.directory}: ${failure.error}`)
				.join("; ")}`;
			if (workerRunFailed) {
				console.error(message);
			} else {
				throw new Error(message);
			}
		}
	}
}
