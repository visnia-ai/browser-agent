import * as fs from "fs";
import { fork, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const WORKER_MODE_FLAG = "--worker-child";

interface NumericStatsWithPercentiles {
	count: number;
	median: number;
	mean: number;
	min: number;
	max: number;
	percentiles: Record<string, number>;
}

interface ParsedFileMetrics {
	validatorSucceededTaskRuns: number;
	executorCompletedTaskRuns: number;
	validatorSignalCount: number;
	trajectoryCount: number;
	trajectoryDurationsMs: number[];
	successfulTrajectoryDurationsMs: number[];
	stepCountsPerAttempt: number[];
	tokenCountsPerStep: number[];
	inputTokenCountsPerStep: number[];
	cachedInputTokenCountsPerStep: number[];
	reasoningTokenCountsPerStep: number[];
	nonReasoningOutputTokenCountsPerStep: number[];
	outputTokenCountsPerStep: number[];
	trajectoryDurationMsPerAttempt: number[];
	stepDurationMs: number[];
	tokenGenerationMs: number[];
	browserInteractionMs: number[];
}

interface ErrorTaskRecord {
	taskIndex: number;
	errors: string[];
}

interface ErrorMessageAggregate {
	message: string;
	count: number;
	taskIndices: number[];
}

interface WorkerInitMessage {
	type: "init";
	files: string[];
}

interface WorkerProgressMessage {
	type: "progress";
	processedFiles: number;
}

interface WorkerDoneMessage {
	type: "done";
	metrics: ParsedFileMetrics;
}

interface WorkerErrorMessage {
	type: "error";
	message: string;
}

type ParentToWorkerMessage = WorkerInitMessage;
type WorkerToParentMessage =
	| WorkerProgressMessage
	| WorkerDoneMessage
	| WorkerErrorMessage;

function printUsage(): void {
	console.error(
		"Usage: tsx scripts/report-task-outcomes.ts <jsonlDir> <pipelineConfigYaml> [--workers N]",
	);
	console.error(
		"Example: tsx scripts/report-task-outcomes.ts /path/to/results ../config/pipeline.yaml --workers 10",
	);
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function formatNumber(value: number): string {
	return String(round2(value));
}

function formatPercent(numerator: number, denominator: number): string {
	if (denominator <= 0) return "N/A";
	return `${formatNumber((numerator / denominator) * 100)}%`;
}

function formatIntegerWithCommas(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function padLeft(value: string, width: number): string {
	return value.length >= width
		? value
		: `${" ".repeat(width - value.length)}${value}`;
}

function buildPercentileGraph(percentiles: Record<string, number>): string {
	const entries = Object.entries(percentiles)
		.map(([label, value]) => [label, value] as const)
		.filter(([, value]) => Number.isFinite(value))
		.sort(
			([leftLabel], [rightLabel]) =>
				Number.parseInt(leftLabel.slice(1), 10) -
				Number.parseInt(rightLabel.slice(1), 10),
		);
	if (entries.length === 0) return "";

	const maxValue = Math.max(...entries.map(([, value]) => value));
	const barWidth = 30;

	return entries
		.map(([label, value]) => {
			const normalizedWidth =
				maxValue <= 0 ? 0 : Math.round((value / maxValue) * barWidth);
			const bar = "#".repeat(normalizedWidth);
			return `${padLeft(label, 4)} | ${bar.padEnd(barWidth, " ")} ${formatNumber(value)}`;
		})
		.join("\n");
}

function truncateMessage(message: string, maxLength = 240): string {
	if (message.length <= maxLength) return message;
	return `${message.slice(0, maxLength - 3)}...`;
}

function normalizeStatsForOutput(
	stats: NumericStatsWithPercentiles | null,
): Record<string, unknown> {
	if (!stats) {
		return { status: "no data" };
	}
	return {
		count: stats.count,
		median: stats.median,
		mean: stats.mean,
		min: stats.min,
		max: stats.max,
		percentilesGraph: buildPercentileGraph(stats.percentiles),
	};
}

function percentileFromSorted(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	if (sorted.length === 1) return sorted[0];
	const clampedP = Math.max(0, Math.min(1, p));
	const index = (sorted.length - 1) * clampedP;
	const low = Math.floor(index);
	const high = Math.ceil(index);
	if (low === high) return sorted[low];
	const weight = index - low;
	return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function buildPercentilesFromSorted(sorted: number[]): Record<string, number> {
	const percentiles: Record<string, number> = {};
	for (let pct = 0; pct <= 100; pct += 5) {
		percentiles[`p${pct}`] = round2(
			percentileFromSorted(sorted, pct / 100),
		);
	}
	return percentiles;
}

function summarizeWithPercentiles(
	values: number[],
): NumericStatsWithPercentiles | null {
	if (values.length === 0) return null;
	let sum = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const value of values) {
		sum += value;
		if (value < min) min = value;
		if (value > max) max = value;
	}
	const mean = sum / values.length;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0
			? (sorted[mid - 1] + sorted[mid]) / 2
			: sorted[mid];

	return {
		count: values.length,
		median: round2(median),
		mean: round2(mean),
		min: round2(min),
		max: round2(max),
		percentiles: buildPercentilesFromSorted(sorted),
	};
}

function summarizeImageUrl(_url: unknown): string {
	return "[image_url omitted]";
}

function normalizeContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const type = (part as Record<string, unknown>).type;
		if (type === "text") {
			const text = (part as Record<string, unknown>).text;
			if (typeof text === "string") parts.push(text);
			continue;
		}
		if (type === "image_url") {
			const imageUrl = (part as Record<string, unknown>).image_url as
				| Record<string, unknown>
				| undefined;
			const url = imageUrl?.url;
			parts.push(summarizeImageUrl(url));
			continue;
		}
	}
	return parts.join("\n");
}

function extractDoneFromAssistantContent(content: string): boolean {
	try {
		const parsed = yaml.load(content);
		if (
			parsed &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			"done" in parsed
		) {
			const done = (parsed as Record<string, unknown>).done;
			if (typeof done === "boolean") return done;
		}
	} catch {
		// Fall back to regex if assistant content is not valid YAML.
	}
	return /(^|\n)\s*done\s*:\s*true(\s|$)/i.test(content);
}

function extractValidatorSuccessFromEntry(
	entry: Record<string, unknown>,
): boolean | null {
	if (typeof entry.successful === "boolean") return entry.successful;
	return null;
}

function extractExecutorCompletionFromEntry(
	entry: Record<string, unknown>,
): boolean {
	if (typeof entry.completed === "boolean") return entry.completed;
	if (typeof entry.done === "boolean") return entry.done;
	const steps = Array.isArray(entry.steps) ? entry.steps : [];
	if (steps.length === 0) return false;
	const lastStep = steps[steps.length - 1];
	if (!lastStep || typeof lastStep !== "object") return false;
	const messages = Array.isArray(
		(lastStep as Record<string, unknown>).messages,
	)
		? ((lastStep as Record<string, unknown>).messages as unknown[])
		: [];

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const role = (message as Record<string, unknown>).role;
		if (role !== "assistant") continue;
		const contentText = normalizeContentToText(
			(message as Record<string, unknown>).content,
		);
		if (!contentText.trim()) return false;
		return extractDoneFromAssistantContent(contentText);
	}
	return false;
}

function finiteNumberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNonNegativeNumberOrNull(value: unknown): number | null {
	const number = finiteNumberOrNull(value);
	return number !== null && number >= 0 ? number : null;
}

function appendRecordedTokenUsage(
	metrics: ParsedFileMetrics,
	rawUsage: unknown,
): void {
	if (!rawUsage || typeof rawUsage !== "object") return;
	const usage = rawUsage as Record<string, unknown>;
	const inputTokens = finiteNonNegativeNumberOrNull(usage.input_tokens);
	const cachedInputTokens = usage.cached_input_tokens;
	const reasoningTokens = usage.reasoning_tokens;
	const nonReasoningOutputTokens = usage.non_reasoning_output_tokens;
	const outputTokens = finiteNonNegativeNumberOrNull(usage.output_tokens);
	const totalTokens = finiteNonNegativeNumberOrNull(usage.total_tokens);

	if (inputTokens !== null) metrics.inputTokenCountsPerStep.push(inputTokens);
	if (cachedInputTokens === undefined) {
		metrics.cachedInputTokenCountsPerStep.push(0);
	} else {
		const value = finiteNonNegativeNumberOrNull(cachedInputTokens);
		if (value !== null) metrics.cachedInputTokenCountsPerStep.push(value);
	}
	if (reasoningTokens === undefined) {
		metrics.reasoningTokenCountsPerStep.push(0);
	} else {
		const value = finiteNonNegativeNumberOrNull(reasoningTokens);
		if (value !== null) metrics.reasoningTokenCountsPerStep.push(value);
	}
	if (nonReasoningOutputTokens === undefined) {
		if (reasoningTokens === undefined && outputTokens !== null) {
			metrics.nonReasoningOutputTokenCountsPerStep.push(outputTokens);
		}
	} else {
		const value = finiteNonNegativeNumberOrNull(
			nonReasoningOutputTokens,
		);
		if (value !== null) {
			metrics.nonReasoningOutputTokenCountsPerStep.push(value);
		}
	}
	if (outputTokens !== null) metrics.outputTokenCountsPerStep.push(outputTokens);
	if (totalTokens !== null) metrics.tokenCountsPerStep.push(totalTokens);
}

function extractRuntimeMetrics(entry: Record<string, unknown>): {
	trajectoryDurationMs: number;
	stepDurationMs: number[];
	tokenGenerationMs: number[];
	browserInteractionMs: number[];
} | null {
	if (!Array.isArray(entry.stepRuntimeMetrics)) return null;
	const stepDurationMs: number[] = [];
	const tokenGenerationMs: number[] = [];
	const browserInteractionMs: number[] = [];
	for (const rawMetric of entry.stepRuntimeMetrics) {
		if (!rawMetric || typeof rawMetric !== "object") continue;
		const metric = rawMetric as Record<string, unknown>;
		const totalDurationMs = finiteNumberOrNull(metric.totalDurationMs);
		if (totalDurationMs === null || totalDurationMs < 0) continue;
		stepDurationMs.push(totalDurationMs);
		const tokenMs = finiteNumberOrNull(metric.tokenGenerationMs);
		if (tokenMs !== null && tokenMs >= 0) tokenGenerationMs.push(tokenMs);
		const browserMs = finiteNumberOrNull(metric.browserInteractionMs);
		if (browserMs !== null && browserMs >= 0) {
			browserInteractionMs.push(browserMs);
		}
	}
	if (stepDurationMs.length === 0) return null;
	const reportedTrajectoryDurationMs = finiteNumberOrNull(
		entry.trajectoryDurationMs,
	);
	return {
		trajectoryDurationMs:
			reportedTrajectoryDurationMs !== null &&
			reportedTrajectoryDurationMs >= 0
				? reportedTrajectoryDurationMs
				: stepDurationMs.reduce(
						(sum, durationMs) => sum + durationMs,
						0,
					),
		stepDurationMs,
		tokenGenerationMs,
		browserInteractionMs,
	};
}

function collectJsonlFiles(rootDir: string): string[] {
	const files: string[] = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const currentDir = stack.pop() as string;
		const entries = fs.readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl"))
				files.push(fullPath);
		}
	}
	return files.sort();
}

function collectTokenUsageFiles(rootDir: string): string[] {
	const tokenUsageDir = path.join(rootDir, "tokenUsage");
	if (!fs.existsSync(tokenUsageDir)) return [];
	return fs
		.readdirSync(tokenUsageDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => path.join(tokenUsageDir, entry.name))
		.sort();
}

function parseTokenUsageArtifacts(rootDir: string): ParsedFileMetrics {
	const metrics = createEmptyMetrics();
	for (const filePath of collectTokenUsageFiles(rootDir)) {
		const artifact = JSON.parse(
			fs.readFileSync(filePath, "utf-8"),
		) as Record<string, unknown>;
		if (artifact.schemaVersion !== 1 || !Array.isArray(artifact.attempts)) {
			throw new Error(`Invalid token usage artifact: ${filePath}`);
		}
		const attempts = artifact.attempts;
		for (const rawAttempt of attempts) {
			if (!rawAttempt || typeof rawAttempt !== "object") continue;
			const invocations = Array.isArray(
				(rawAttempt as Record<string, unknown>).invocations,
			)
				? ((rawAttempt as Record<string, unknown>)
						.invocations as unknown[])
				: [];
			for (const rawInvocation of invocations) {
				if (!rawInvocation || typeof rawInvocation !== "object") continue;
				appendRecordedTokenUsage(
					metrics,
					(rawInvocation as Record<string, unknown>).usage,
				);
			}
		}
	}
	return metrics;
}

function getErrorTasksPath(rootDir: string): string | null {
	const entries = fs.readdirSync(rootDir, { withFileTypes: true });
	const matches = entries
		.filter(
			(entry) =>
				entry.isFile() && entry.name.endsWith(".error-tasks.json"),
		)
		.map((entry) => path.join(rootDir, entry.name))
		.sort();
	return matches[0] ?? null;
}

function loadErrorTaskRecords(rootDir: string): ErrorTaskRecord[] {
	const errorTasksPath = getErrorTasksPath(rootDir);
	if (!errorTasksPath) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(errorTasksPath, "utf-8"));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const records: ErrorTaskRecord[] = [];
	for (const entry of parsed) {
		if (Number.isInteger(entry) && entry >= 1) {
			records.push({ taskIndex: entry, errors: [] });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const rawTaskIndex = (entry as { taskIndex?: unknown }).taskIndex;
		const taskIndex =
			typeof rawTaskIndex === "number" ? rawTaskIndex : Number.NaN;
		const rawErrors = (entry as { errors?: unknown }).errors;
		if (!Number.isInteger(taskIndex) || taskIndex < 1) continue;
		const errors = Array.isArray(rawErrors)
			? rawErrors.filter(
					(message): message is string =>
						typeof message === "string" &&
						message.trim().length > 0,
				)
			: [];
		records.push({ taskIndex, errors });
	}

	return records.sort((left, right) => left.taskIndex - right.taskIndex);
}

function buildErrorMessageAggregates(
	errorTaskRecords: ErrorTaskRecord[],
): ErrorMessageAggregate[] {
	const byMessage = new Map<
		string,
		{ count: number; taskIndices: Set<number> }
	>();

	for (const record of errorTaskRecords) {
		for (const error of record.errors) {
			const normalized = error.trim();
			if (!normalized) continue;
			const current = byMessage.get(normalized) ?? {
				count: 0,
				taskIndices: new Set<number>(),
			};
			current.count += 1;
			current.taskIndices.add(record.taskIndex);
			byMessage.set(normalized, current);
		}
	}

	return [...byMessage.entries()]
		.map(([message, value]) => ({
			message,
			count: value.count,
			taskIndices: [...value.taskIndices].sort((a, b) => a - b),
		}))
		.sort((left, right) => {
			if (right.count !== left.count) return right.count - left.count;
			if (right.taskIndices.length !== left.taskIndices.length) {
				return right.taskIndices.length - left.taskIndices.length;
			}
			return left.message.localeCompare(right.message);
		});
}

function writeErrorInvestigationReport(
	rootDir: string,
	errorTaskRecords: ErrorTaskRecord[],
	errorMessageAggregates: ErrorMessageAggregate[],
): string {
	const outputPath = path.join(rootDir, "error-message-report.json");
	const payload = {
		generatedAt: new Date().toISOString(),
		errorTaskCount: errorTaskRecords.length,
		totalCollectedErrors: errorTaskRecords.reduce(
			(sum, record) => sum + record.errors.length,
			0,
		),
		uniqueErrorMessageCount: errorMessageAggregates.length,
		tasks: errorTaskRecords,
		errorMessages: errorMessageAggregates,
	};
	fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");
	return outputPath;
}

function getTaskAttemptDenominator(configPath: string): number {
	const raw = fs.readFileSync(configPath, "utf-8");
	const parsed = yaml.load(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return 0;
	const cfg = parsed as Record<string, unknown>;

	const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [];
	const configuredTasks = tasks.filter((task) => {
		if (typeof task === "string") return task.trim().length > 0;
		if (!task || typeof task !== "object" || Array.isArray(task)) {
			return false;
		}
		const taskText = (task as Record<string, unknown>).task;
		return typeof taskText === "string" && taskText.trim().length > 0;
	}).length;
	const taskRuns =
		typeof cfg.task_runs === "number" &&
		Number.isFinite(cfg.task_runs) &&
		cfg.task_runs > 0
			? Math.floor(cfg.task_runs)
			: 1;

	return configuredTasks * taskRuns;
}

function mergeParsedMetrics(
	current: ParsedFileMetrics,
	next: ParsedFileMetrics,
): ParsedFileMetrics {
	current.validatorSucceededTaskRuns += next.validatorSucceededTaskRuns;
	current.executorCompletedTaskRuns += next.executorCompletedTaskRuns;
	current.validatorSignalCount += next.validatorSignalCount;
	current.trajectoryCount += next.trajectoryCount;
	current.trajectoryDurationsMs.push(...next.trajectoryDurationsMs);
	current.successfulTrajectoryDurationsMs.push(
		...next.successfulTrajectoryDurationsMs,
	);
	current.stepCountsPerAttempt.push(...next.stepCountsPerAttempt);
	current.tokenCountsPerStep.push(...next.tokenCountsPerStep);
	current.inputTokenCountsPerStep.push(...next.inputTokenCountsPerStep);
	current.cachedInputTokenCountsPerStep.push(
		...next.cachedInputTokenCountsPerStep,
	);
	current.reasoningTokenCountsPerStep.push(
		...next.reasoningTokenCountsPerStep,
	);
	current.nonReasoningOutputTokenCountsPerStep.push(
		...next.nonReasoningOutputTokenCountsPerStep,
	);
	current.outputTokenCountsPerStep.push(...next.outputTokenCountsPerStep);
	current.trajectoryDurationMsPerAttempt.push(
		...next.trajectoryDurationMsPerAttempt,
	);
	current.stepDurationMs.push(...next.stepDurationMs);
	current.tokenGenerationMs.push(...next.tokenGenerationMs);
	current.browserInteractionMs.push(...next.browserInteractionMs);
	return current;
}

function createEmptyMetrics(): ParsedFileMetrics {
	return {
		validatorSucceededTaskRuns: 0,
		executorCompletedTaskRuns: 0,
		validatorSignalCount: 0,
		trajectoryCount: 0,
		trajectoryDurationsMs: [],
		successfulTrajectoryDurationsMs: [],
		stepCountsPerAttempt: [],
		tokenCountsPerStep: [],
		inputTokenCountsPerStep: [],
		cachedInputTokenCountsPerStep: [],
		reasoningTokenCountsPerStep: [],
		nonReasoningOutputTokenCountsPerStep: [],
		outputTokenCountsPerStep: [],
		trajectoryDurationMsPerAttempt: [],
		stepDurationMs: [],
		tokenGenerationMs: [],
		browserInteractionMs: [],
	};
}

function splitIntoNQueues<T>(items: T[], n: number): T[][] {
	const queueCount = Math.max(1, Math.min(Math.floor(n), items.length));
	const queues = Array.from({ length: queueCount }, () => [] as T[]);
	for (let i = 0; i < items.length; i++) {
		queues[i % queueCount].push(items[i]);
	}
	return queues.filter((queue) => queue.length > 0);
}

function renderProgressBar(
	processedFiles: number,
	totalFiles: number,
	startedAtMs: number,
): void {
	const width = 32;
	const clampedProcessed = Math.max(
		0,
		Math.min(totalFiles, Math.floor(processedFiles)),
	);
	const fraction = totalFiles > 0 ? clampedProcessed / totalFiles : 1;
	const filledWidth = Math.max(
		0,
		Math.min(width, Math.round(width * fraction)),
	);
	const bar = `${"#".repeat(filledWidth)}${"-".repeat(width - filledWidth)}`;
	const pct = totalFiles > 0 ? (fraction * 100).toFixed(1) : "100.0";
	const elapsedSeconds = ((Date.now() - startedAtMs) / 1000).toFixed(1);
	process.stderr.write(
		`\rParsing JSONL files [${bar}] ${clampedProcessed}/${totalFiles} (${pct}%) elapsed ${elapsedSeconds}s`,
	);
	if (clampedProcessed >= totalFiles) process.stderr.write("\n");
}

function createProgressUpdater(totalFiles: number): (delta?: number) => void {
	let processedFiles = 0;
	let lastDrawMs = 0;
	const startedAtMs = Date.now();
	renderProgressBar(0, totalFiles, startedAtMs);
	return (delta = 1): void => {
		processedFiles += delta;
		const now = Date.now();
		const shouldDraw =
			processedFiles >= totalFiles ||
			now - lastDrawMs >= 80 ||
			totalFiles <= 50;
		if (!shouldDraw) return;
		lastDrawMs = now;
		renderProgressBar(processedFiles, totalFiles, startedAtMs);
	};
}

async function processFilesSequentially(
	jsonlFiles: string[],
	onFileProcessed: (delta?: number) => void,
): Promise<ParsedFileMetrics> {
	const merged = createEmptyMetrics();
	for (const jsonlFile of jsonlFiles) {
		const metrics = await parseFile(jsonlFile);
		mergeParsedMetrics(merged, metrics);
		onFileProcessed(1);
	}
	return merged;
}

function waitForWorkerInitMessage(): Promise<WorkerInitMessage> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error("Worker timed out waiting for init message."));
		}, 10_000);

		process.once("message", (message: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (!message || typeof message !== "object") {
				reject(new Error("Worker received an invalid init payload."));
				return;
			}
			const msg = message as Partial<WorkerInitMessage>;
			if (msg.type !== "init" || !Array.isArray(msg.files)) {
				reject(new Error("Worker received malformed init payload."));
				return;
			}
			resolve({
				type: "init",
				files: msg.files.filter((file) => typeof file === "string"),
			});
		});
	});
}

async function runWorkerChildMain(): Promise<void> {
	const init = await waitForWorkerInitMessage();
	const merged = createEmptyMetrics();
	for (const filePath of init.files) {
		const metrics = await parseFile(filePath);
		mergeParsedMetrics(merged, metrics);
		process.send?.({
			type: "progress",
			processedFiles: 1,
		} satisfies WorkerProgressMessage);
	}
	process.send?.({
		type: "done",
		metrics: merged,
	} satisfies WorkerDoneMessage);
}

function spawnWorkerForQueue(
	files: string[],
	onFileProcessed: (delta?: number) => void,
	children: ChildProcess[],
): Promise<ParsedFileMetrics> {
	return new Promise((resolve, reject) => {
		const scriptPath = fileURLToPath(import.meta.url);
		const child = fork(scriptPath, [WORKER_MODE_FLAG], {
			execArgv: process.execArgv,
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		children.push(child);

		let settled = false;
		const resolveOnce = (metrics: ParsedFileMetrics): void => {
			if (settled) return;
			settled = true;
			resolve(metrics);
		};
		const rejectOnce = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};

		child.on("message", (message: unknown) => {
			if (!message || typeof message !== "object") return;
			const msg = message as Partial<WorkerToParentMessage>;
			if (msg.type === "progress") {
				const processed =
					typeof msg.processedFiles === "number" &&
					Number.isInteger(msg.processedFiles) &&
					msg.processedFiles > 0
						? msg.processedFiles
						: 1;
				onFileProcessed(processed);
				return;
			}
			if (msg.type === "done") {
				const metrics = msg.metrics;
				if (!metrics || typeof metrics !== "object") {
					rejectOnce(new Error("Worker returned malformed metrics."));
					return;
				}
				resolveOnce(metrics as ParsedFileMetrics);
				return;
			}
			if (msg.type === "error") {
				const errorMessage =
					typeof msg.message === "string" &&
					msg.message.trim().length > 0
						? msg.message
						: "Worker reported an unknown error.";
				rejectOnce(new Error(errorMessage));
			}
		});

		child.once("error", (error: Error) => {
			rejectOnce(error);
		});
		child.once(
			"exit",
			(code: number | null, signal: NodeJS.Signals | null) => {
				if (settled) return;
				const suffix = signal ? ` signal=${signal}` : "";
				rejectOnce(
					new Error(
						`Worker exited before completion (code=${code}${suffix}).`,
					),
				);
			},
		);

		const initMessage: ParentToWorkerMessage = { type: "init", files };
		child.send(initMessage);
	});
}

async function processFilesWithWorkers(
	jsonlFiles: string[],
	workerCount: number,
	onFileProcessed: (delta?: number) => void,
): Promise<ParsedFileMetrics> {
	if (workerCount <= 1 || jsonlFiles.length <= 1) {
		return processFilesSequentially(jsonlFiles, onFileProcessed);
	}

	const queues = splitIntoNQueues(jsonlFiles, workerCount);
	const children: ChildProcess[] = [];
	try {
		const queueResults = await Promise.all(
			queues.map((queue) =>
				spawnWorkerForQueue(queue, onFileProcessed, children),
			),
		);
		const merged = createEmptyMetrics();
		for (const result of queueResults) mergeParsedMetrics(merged, result);
		return merged;
	} catch (error) {
		for (const child of children) {
			if (!child.killed) child.kill();
		}
		throw error;
	}
}

function parsePositiveIntArg(raw: string, argName: string): number {
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(
			`${argName} must be a positive integer, received: ${raw}`,
		);
	}
	return parsed;
}

function resolveRequestedWorkerCount(
	rawArgs: string[],
	jsonlFilesCount: number,
): number {
	let explicitWorkers: number | null = null;
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--workers" || arg === "-w") {
			const rawValue = rawArgs[i + 1];
			if (!rawValue) {
				throw new Error(`${arg} requires a numeric value.`);
			}
			explicitWorkers = parsePositiveIntArg(rawValue, arg);
			i += 1;
			continue;
		}
		if (arg.startsWith("--workers=")) {
			explicitWorkers = parsePositiveIntArg(
				arg.slice("--workers=".length),
				"--workers",
			);
			continue;
		}
		if (arg.startsWith("-w=")) {
			explicitWorkers = parsePositiveIntArg(
				arg.slice("-w=".length),
				"-w",
			);
		}
	}

	const maxWorkers = Math.max(1, jsonlFilesCount);
	if (explicitWorkers !== null) return Math.min(explicitWorkers, maxWorkers);

	const available = Math.max(1, availableParallelism());
	return Math.min(available, maxWorkers);
}

function extractPositionalArgs(rawArgs: string[]): string[] {
	const positionalArgs: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--workers" || arg === "-w") {
			i += 1;
			continue;
		}
		if (arg.startsWith("--workers=") || arg.startsWith("-w=")) continue;
		if (arg.startsWith("-")) continue;
		positionalArgs.push(arg);
	}
	return positionalArgs;
}

async function parseFile(filePath: string): Promise<ParsedFileMetrics> {
	let validatorSucceededTaskRuns = 0;
	let executorCompletedTaskRuns = 0;
	let validatorSignalCount = 0;
	let trajectoryCount = 0;
	const trajectoryDurationsMs: number[] = [];
	const successfulTrajectoryDurationsMs: number[] = [];
	const stepCountsPerAttempt: number[] = [];
	const tokenCountsPerStep: number[] = [];
	const inputTokenCountsPerStep: number[] = [];
	const cachedInputTokenCountsPerStep: number[] = [];
	const reasoningTokenCountsPerStep: number[] = [];
	const nonReasoningOutputTokenCountsPerStep: number[] = [];
	const outputTokenCountsPerStep: number[] = [];
	const trajectoryDurationMsPerAttempt: number[] = [];
	const stepDurationMs: number[] = [];
	const tokenGenerationMs: number[] = [];
	const browserInteractionMs: number[] = [];
	const seenRuns = new Set<number>();

	const input = fs.createReadStream(filePath, { encoding: "utf-8" });
	const rl = readline.createInterface({
		input,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const rawLine of rl) {
		const line = rawLine.trim();
		if (!line) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			continue;
		const entry = parsed as Record<string, unknown>;
		const explicitRun = entry.run;
		if (
			typeof explicitRun === "number" &&
			Number.isInteger(explicitRun) &&
			explicitRun > 0
		) {
			if (seenRuns.has(explicitRun)) continue;
			seenRuns.add(explicitRun);
		}

		const steps = Array.isArray(entry.steps) ? entry.steps : [];
		trajectoryCount += 1;
		stepCountsPerAttempt.push(steps.length);

		const validatorSuccess = extractValidatorSuccessFromEntry(entry);
		const durationMs = entry.durationMs;
		if (
			typeof durationMs === "number" &&
			Number.isFinite(durationMs) &&
			durationMs >= 0
		) {
			trajectoryDurationsMs.push(durationMs);
			if (validatorSuccess === true) {
				successfulTrajectoryDurationsMs.push(durationMs);
			}
		}
		if (validatorSuccess !== null) {
			validatorSignalCount += 1;
			if (validatorSuccess) validatorSucceededTaskRuns += 1;
		}

		if (extractExecutorCompletionFromEntry(entry))
			executorCompletedTaskRuns += 1;

		const runtimeMetrics = extractRuntimeMetrics(entry);
		if (runtimeMetrics) {
			trajectoryDurationMsPerAttempt.push(
				runtimeMetrics.trajectoryDurationMs,
			);
			stepDurationMs.push(...runtimeMetrics.stepDurationMs);
			tokenGenerationMs.push(...runtimeMetrics.tokenGenerationMs);
			browserInteractionMs.push(...runtimeMetrics.browserInteractionMs);
		}
	}

	return {
		validatorSucceededTaskRuns,
		executorCompletedTaskRuns,
		validatorSignalCount,
		trajectoryCount,
		trajectoryDurationsMs,
		successfulTrajectoryDurationsMs,
		stepCountsPerAttempt,
		tokenCountsPerStep,
		inputTokenCountsPerStep,
		cachedInputTokenCountsPerStep,
		reasoningTokenCountsPerStep,
		nonReasoningOutputTokenCountsPerStep,
		outputTokenCountsPerStep,
		trajectoryDurationMsPerAttempt,
		stepDurationMs,
		tokenGenerationMs,
		browserInteractionMs,
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const askedForHelp =
		process.argv.includes("--help") || process.argv.includes("-h");
	if (askedForHelp) {
		printUsage();
		process.exit(0);
	}

	const positionalArgs = extractPositionalArgs(args);
	if (positionalArgs.length < 2) {
		printUsage();
		process.exit(1);
	}

	const jsonlDir = path.resolve(positionalArgs[0]);
	const configPath = path.resolve(positionalArgs[1]);

	if (!fs.existsSync(jsonlDir) || !fs.statSync(jsonlDir).isDirectory()) {
		console.error(
			`Invalid jsonlDir (must be an existing directory): ${jsonlDir}`,
		);
		process.exit(1);
	}
	if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
		console.error(
			`Invalid pipelineConfigYaml (must be an existing file): ${configPath}`,
		);
		process.exit(1);
	}

	const jsonlFiles = collectJsonlFiles(jsonlDir);
	if (jsonlFiles.length === 0) {
		console.error(`No .jsonl files found under: ${jsonlDir}`);
		process.exit(1);
	}

	const requestedWorkerCount = resolveRequestedWorkerCount(
		args,
		jsonlFiles.length,
	);
	const onFileProcessed = createProgressUpdater(jsonlFiles.length);
	const aggregatedMetrics = await processFilesWithWorkers(
		jsonlFiles,
		requestedWorkerCount,
		onFileProcessed,
	);
	mergeParsedMetrics(
		aggregatedMetrics,
		parseTokenUsageArtifacts(jsonlDir),
	);
	const errorTaskRecords = loadErrorTaskRecords(jsonlDir);
	const errorMessageAggregates =
		buildErrorMessageAggregates(errorTaskRecords);
	const errorInvestigationReportPath = writeErrorInvestigationReport(
		jsonlDir,
		errorTaskRecords,
		errorMessageAggregates,
	);

	const totalTaskAttempts = getTaskAttemptDenominator(configPath);
	const validatorFailedTaskRuns = Math.max(
		totalTaskAttempts - aggregatedMetrics.validatorSucceededTaskRuns,
		0,
	);
	const validatorSuccessRatePct = formatPercent(
		aggregatedMetrics.validatorSucceededTaskRuns,
		totalTaskAttempts,
	);
	const executorIncompleteTaskRuns = Math.max(
		totalTaskAttempts - aggregatedMetrics.executorCompletedTaskRuns,
		0,
	);
	const executorCompletionRatePct = formatPercent(
		aggregatedMetrics.executorCompletedTaskRuns,
		totalTaskAttempts,
	);
	const totalTokensAcrossAllTaskSteps =
		aggregatedMetrics.tokenCountsPerStep.reduce(
			(sum, tokenCount) => sum + tokenCount,
			0,
		);
	const totalInputTokensAcrossAllTaskSteps =
		aggregatedMetrics.inputTokenCountsPerStep.reduce(
			(sum, inputTokenCount) => sum + inputTokenCount,
			0,
		);
	const totalOutputTokensAcrossAllTaskSteps =
		aggregatedMetrics.outputTokenCountsPerStep.reduce(
			(sum, outputTokenCount) => sum + outputTokenCount,
			0,
		);
	const totalCachedInputTokensAcrossAllTaskSteps =
		aggregatedMetrics.cachedInputTokenCountsPerStep.reduce(
			(sum, cachedInputTokenCount) => sum + cachedInputTokenCount,
			0,
		);
	const totalReasoningTokensAcrossAllTaskSteps =
		aggregatedMetrics.reasoningTokenCountsPerStep.reduce(
			(sum, reasoningTokenCount) => sum + reasoningTokenCount,
			0,
		);
	const totalNonReasoningOutputTokensAcrossAllTaskSteps =
		aggregatedMetrics.nonReasoningOutputTokenCountsPerStep.reduce(
			(sum, nonReasoningOutputTokenCount) =>
				sum + nonReasoningOutputTokenCount,
			0,
		);
	const totalTrajectoryDurationMs =
		aggregatedMetrics.trajectoryDurationsMs.reduce(
			(sum, durationMs) => sum + durationMs,
			0,
		);
	const successfulTrajectoryDurationCount =
		aggregatedMetrics.successfulTrajectoryDurationsMs.length;
	const averageSuccessfulTrajectoryDurationMs =
		successfulTrajectoryDurationCount > 0
			? round2(
					aggregatedMetrics.successfulTrajectoryDurationsMs.reduce(
						(sum, durationMs) => sum + durationMs,
						0,
					) / successfulTrajectoryDurationCount,
				)
			: "N/A";
	const totalRuntimeTrajectoryDurationMs =
		aggregatedMetrics.trajectoryDurationMsPerAttempt.reduce(
			(sum, durationMs) => sum + durationMs,
			0,
		);

	const report = {
		successRate: {
			succeededTaskRuns: aggregatedMetrics.validatorSucceededTaskRuns,
			totalTaskAttempts,
			percentage: validatorSuccessRatePct,
			fraction: `${aggregatedMetrics.validatorSucceededTaskRuns}/${totalTaskAttempts}`,
		},
		validatorSuccessRate: {
			succeededTaskRuns: aggregatedMetrics.validatorSucceededTaskRuns,
			totalTaskAttempts,
			percentage: validatorSuccessRatePct,
			fraction: `${aggregatedMetrics.validatorSucceededTaskRuns}/${totalTaskAttempts}`,
			validatorSignalCount: aggregatedMetrics.validatorSignalCount,
			validatorCoveragePct: formatPercent(
				aggregatedMetrics.validatorSignalCount,
				totalTaskAttempts,
			),
		},
		executorCompletionRate: {
			completedTaskRuns: aggregatedMetrics.executorCompletedTaskRuns,
			totalTaskAttempts,
			percentage: executorCompletionRatePct,
			fraction: `${aggregatedMetrics.executorCompletedTaskRuns}/${totalTaskAttempts}`,
		},
		totalTokensAcrossAllTaskSteps: formatIntegerWithCommas(
			totalTokensAcrossAllTaskSteps,
		),
		totalInputTokensAcrossAllTaskSteps: formatIntegerWithCommas(
			totalInputTokensAcrossAllTaskSteps,
		),
		totalCachedInputTokensAcrossAllTaskSteps: formatIntegerWithCommas(
			totalCachedInputTokensAcrossAllTaskSteps,
		),
		totalReasoningTokensAcrossAllTaskSteps: formatIntegerWithCommas(
			totalReasoningTokensAcrossAllTaskSteps,
		),
		totalNonReasoningOutputTokensAcrossAllTaskSteps:
			formatIntegerWithCommas(
				totalNonReasoningOutputTokensAcrossAllTaskSteps,
			),
		totalOutputTokensAcrossAllTaskSteps: formatIntegerWithCommas(
			totalOutputTokensAcrossAllTaskSteps,
		),
		totalTrajectoryDurationMs: round2(totalTrajectoryDurationMs),
		averageSuccessfulTrajectoryDurationMs,
		trajectoryDurationCoverage: {
			timedTrajectories: aggregatedMetrics.trajectoryDurationsMs.length,
			totalTrajectories: aggregatedMetrics.trajectoryCount,
			percentage: formatPercent(
				aggregatedMetrics.trajectoryDurationsMs.length,
				aggregatedMetrics.trajectoryCount,
			),
			fraction: `${aggregatedMetrics.trajectoryDurationsMs.length}/${aggregatedMetrics.trajectoryCount}`,
		},
		timing: {
			coverage: `${aggregatedMetrics.trajectoryDurationMsPerAttempt.length}/${totalTaskAttempts}`,
			totalTrajectoryDurationMs: round2(totalRuntimeTrajectoryDurationMs),
			totalTrajectoryDurationSeconds: round2(
				totalRuntimeTrajectoryDurationMs / 1000,
			),
			trajectoryDurationMsPerAttempt: normalizeStatsForOutput(
				summarizeWithPercentiles(
					aggregatedMetrics.trajectoryDurationMsPerAttempt,
				),
			),
			stepDurationMs: normalizeStatsForOutput(
				summarizeWithPercentiles(aggregatedMetrics.stepDurationMs),
			),
			tokenGenerationMsPerStep: normalizeStatsForOutput(
				summarizeWithPercentiles(aggregatedMetrics.tokenGenerationMs),
			),
			browserInteractionMsPerStep: normalizeStatsForOutput(
				summarizeWithPercentiles(
					aggregatedMetrics.browserInteractionMs,
				),
			),
		},
		tokensPerStep: normalizeStatsForOutput(
			summarizeWithPercentiles(aggregatedMetrics.tokenCountsPerStep),
		),
		inputTokensPerStep: normalizeStatsForOutput(
			summarizeWithPercentiles(aggregatedMetrics.inputTokenCountsPerStep),
		),
		cachedInputTokensPerStep: normalizeStatsForOutput(
			summarizeWithPercentiles(
				aggregatedMetrics.cachedInputTokenCountsPerStep,
			),
		),
		reasoningTokensPerStep: normalizeStatsForOutput(
			summarizeWithPercentiles(
				aggregatedMetrics.reasoningTokenCountsPerStep,
			),
		),
		nonReasoningOutputTokensPerStep: normalizeStatsForOutput(
			summarizeWithPercentiles(
				aggregatedMetrics.nonReasoningOutputTokenCountsPerStep,
			),
		),
		outputTokensPerStep: normalizeStatsForOutput(
			summarizeWithPercentiles(
				aggregatedMetrics.outputTokenCountsPerStep,
			),
		),
		stepsPerTaskAttempt: normalizeStatsForOutput(
			summarizeWithPercentiles(aggregatedMetrics.stepCountsPerAttempt),
		),
		errors: {
			validatorFailedTaskRuns,
			executorIncompleteTaskRuns,
			errorTaskCount: errorTaskRecords.length,
			totalCollectedErrors: errorTaskRecords.reduce(
				(sum, record) => sum + record.errors.length,
				0,
			),
			uniqueErrorMessageCount: errorMessageAggregates.length,
			errorTaskCoveragePct: formatPercent(
				errorTaskRecords.length,
				totalTaskAttempts,
			),
			topErrorMessages: errorMessageAggregates
				.slice(0, 10)
				.map((entry) => ({
					count: entry.count,
					taskCount: entry.taskIndices.length,
					taskIndices: entry.taskIndices,
					message: truncateMessage(entry.message),
				})),
			investigationReportPath: errorInvestigationReportPath,
		},
	};

	console.log(yaml.dump(report, { noRefs: true, lineWidth: -1 }));
}

if (process.argv.includes(WORKER_MODE_FLAG)) {
	runWorkerChildMain().catch((error: unknown) => {
		const message =
			error instanceof Error
				? error.stack || error.message
				: String(error);
		process.send?.({ type: "error", message } satisfies WorkerErrorMessage);
		process.exit(1);
	});
} else {
	main().catch((error: unknown) => {
		const message =
			error instanceof Error
				? error.stack || error.message
				: String(error);
		console.error(`Failed to produce task outcome report: ${message}`);
		process.exit(1);
	});
}
