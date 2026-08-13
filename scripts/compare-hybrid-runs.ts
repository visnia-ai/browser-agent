import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { estimateTokenCount } from "../src/agents/prompt-token-estimator.js";

type JsonRecord = Record<string, unknown>;
const COMPARISON_SOURCE_FILE = "__comparisonSourceFile";
const COMPARISON_SINGLE_ENTRY = "__comparisonSingleEntry";

interface RunMeasurement {
	task: string;
	category?: string;
	successful: boolean;
	steps: number;
	inputTokens?: number;
	observationTokens: number;
	refErrors: number;
	pageObservationMetrics?: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function jsonlFiles(inputPath: string): string[] {
	const resolved = path.resolve(inputPath);
	const stat = fs.statSync(resolved);
	if (stat.isFile()) return [resolved];
	if (!stat.isDirectory()) {
		throw new Error(`Expected a JSONL file or directory: ${resolved}`);
	}
	return fs
		.readdirSync(resolved, { withFileTypes: true })
		.flatMap((entry) => {
			const child = path.join(resolved, entry.name);
			if (entry.isDirectory()) return jsonlFiles(child);
			return entry.isFile() && entry.name.endsWith(".jsonl")
				? [child]
				: [];
		})
		.sort();
}

function loadEntries(inputPath: string): JsonRecord[] {
	return jsonlFiles(inputPath).flatMap((filePath) =>
		(() => {
			const lines = fs
				.readFileSync(filePath, "utf8")
			.split(/\r?\n/)
			.map((line) => line.trim())
				.filter(Boolean);
			return lines.map((line, index) => {
				const value = JSON.parse(line) as unknown;
				if (!isRecord(value)) {
					throw new Error(
						`Expected object at ${filePath}:${index + 1}`,
					);
				}
				return {
					...value,
					[COMPARISON_SOURCE_FILE]: filePath,
					[COMPARISON_SINGLE_ENTRY]: lines.length === 1,
				};
			});
		})(),
	);
}

function messageText(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (!isRecord(part)) return [];
		return part.type === "text" && typeof part.text === "string"
			? [part.text]
			: [];
	});
}

function promptPayload(step: unknown): JsonRecord | undefined {
	if (!isRecord(step) || !Array.isArray(step.messages)) return undefined;
	const userTexts = step.messages.flatMap((message) => {
		if (!isRecord(message) || message.role !== "user") return [];
		return messageText(message.content);
	});
	for (const text of userTexts.reverse()) {
		try {
			const parsed = yaml.load(text);
			if (
				isRecord(parsed) &&
				("projection" in parsed ||
					"pageObservation" in parsed ||
					"currentURL" in parsed)
			) {
				return parsed;
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

function taskTokenUsageArtifactInputTokens(
	entry: JsonRecord,
): number | undefined {
	if (entry[COMPARISON_SINGLE_ENTRY] !== true) return undefined;
	const sourceFile = entry[COMPARISON_SOURCE_FILE];
	if (typeof sourceFile !== "string") return undefined;
	const taskMatch = /^steps-task-(\d+)\.jsonl$/.exec(
		path.basename(sourceFile),
	);
	if (!taskMatch) return undefined;
	const usagePath = path.join(
		path.dirname(sourceFile),
		"tokenUsage",
		`task-${taskMatch[1]}.json`,
	);
	if (!fs.existsSync(usagePath)) return undefined;
	try {
		const artifact = JSON.parse(fs.readFileSync(usagePath, "utf8"));
		return isRecord(artifact) && isRecord(artifact.totals)
			? finiteNumber(artifact.totals.input_tokens)
			: undefined;
	} catch {
		return undefined;
	}
}

function invocationInputTokens(entry: JsonRecord): number | undefined {
	if (!Array.isArray(entry.modelInvocations)) return undefined;
	let found = false;
	let total = 0;
	for (const invocation of entry.modelInvocations) {
		if (!isRecord(invocation) || !isRecord(invocation.usage)) continue;
		const tokens = finiteNumber(invocation.usage.input_tokens);
		if (tokens === undefined || tokens < 0) continue;
		found = true;
		total += tokens;
	}
	return found ? total : undefined;
}

function recordedInputTokens(entry: JsonRecord): number | undefined {
	const artifactTotal = taskTokenUsageArtifactInputTokens(entry);
	if (artifactTotal !== undefined) return artifactTotal;
	const auxiliaryTotal = invocationInputTokens(entry);
	const executorTotal = isRecord(entry.executorTokenTotals)
		? finiteNumber(entry.executorTokenTotals.input_tokens)
		: undefined;
	if (executorTotal !== undefined) {
		return executorTotal + (auxiliaryTotal ?? 0);
	}
	return auxiliaryTotal;
}

function measureEntry(entry: JsonRecord): RunMeasurement {
	const task = typeof entry.task === "string" ? entry.task : "";
	const steps = Array.isArray(entry.steps) ? entry.steps : [];
	const executorSteps = steps.filter(
		(step) => !isRecord(step) || step.step_kind !== "auth_takeover_attempt",
	);
	const executionOverrides = isRecord(entry.executionOverrides)
		? entry.executionOverrides
		: undefined;
	const metadata = isRecord(executionOverrides?.metadata)
		? executionOverrides?.metadata
		: undefined;
	const category =
		typeof entry.category === "string"
			? entry.category
			: typeof metadata?.category === "string"
				? metadata.category
				: undefined;
	let observationTokens = 0;
	let refErrors = 0;
	for (const step of steps) {
		const payload = promptPayload(step);
		if (!payload) continue;
		const observation =
			typeof payload.pageObservation === "string"
				? payload.pageObservation
				: typeof payload.projection === "string"
					? payload.projection
					: "";
		if (observation) observationTokens += estimateTokenCount(observation);
		const errors = Array.isArray(payload.interactionErrors)
			? payload.interactionErrors
			: [];
		refErrors += errors.filter(
			(error) =>
				typeof error === "string" &&
				/(?:\bref\b.*(?:stale|missing|invalid|not found|could not find|resolve)|(?:stale|missing|invalid|not found|could not find|resolve).*\bref\b)/i.test(
					error,
				),
		).length;
	}
	return {
		task,
		...(category ? { category } : {}),
		successful: entry.successful === true,
		steps:
			steps.length > 0
				? executorSteps.length
				: (finiteNumber(entry.browserEquivalentSteps) ??
					finiteNumber(entry.stepsCount) ??
					0),
		inputTokens: recordedInputTokens(entry),
		observationTokens,
		refErrors,
		pageObservationMetrics: isRecord(entry.pageObservationMetrics)
			? entry.pageObservationMetrics
			: undefined,
	};
}

function mean(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function round(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.round(value * 10_000) / 10_000;
}

function fractionSaved(
	candidate: number | undefined,
	baseline: number | undefined,
): number | undefined {
	if (
		candidate === undefined ||
		baseline === undefined ||
		baseline === 0
	) {
		return undefined;
	}
	return round(1 - candidate / baseline);
}

function sumMetric(rows: RunMeasurement[], key: string): number {
	return rows.reduce(
		(total, row) =>
			total + (finiteNumber(row.pageObservationMetrics?.[key]) ?? 0),
		0,
	);
}

function summarize(rows: RunMeasurement[]) {
	const inputTokens = rows.flatMap((row) =>
		row.inputTokens === undefined ? [] : [row.inputTokens],
	);
	return {
		tasks: rows.length,
		successRate: round(
			rows.length
				? rows.filter((row) => row.successful).length / rows.length
				: 0,
		),
		steps: {
			mean: round(mean(rows.map((row) => row.steps))),
			median: round(median(rows.map((row) => row.steps))),
		},
		inputTokens: {
			count: inputTokens.length,
			coverage: `${inputTokens.length}/${rows.length}`,
			mean: round(mean(inputTokens)),
			median: round(median(inputTokens)),
		},
		pageObservationTokens: {
			mean: round(mean(rows.map((row) => row.observationTokens))),
			median: round(median(rows.map((row) => row.observationTokens))),
		},
		staleOrMissingRefErrors: rows.reduce(
			(total, row) => total + row.refErrors,
			0,
		),
		readDiagnostics: {
			totalReads: sumMetric(rows, "totalReads"),
			bootstrapReads: sumMetric(rows, "bootstrapReads"),
			wholePageReads: sumMetric(rows, "wholePageReads"),
			projectedReads: sumMetric(rows, "projectedReads"),
			batchedReads: sumMetric(rows, "batchedReads"),
			standaloneReads: sumMetric(rows, "standaloneReads"),
			unchangedReads: sumMetric(rows, "unchangedReads"),
			truncatedReads: sumMetric(rows, "truncatedReads"),
			zeroMatchProjections: sumMetric(rows, "zeroMatchProjections"),
		},
	};
}

function summarizeCategories(rows: RunMeasurement[]) {
	const byCategory = new Map<string, RunMeasurement[]>();
	for (const row of rows) {
		const category = row.category ?? "uncategorized";
		const group = byCategory.get(category) ?? [];
		group.push(row);
		byCategory.set(category, group);
	}
	return Object.fromEntries(
		[...byCategory.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([category, group]) => [category, summarize(group)]),
	);
}

function pairRuns(baseline: RunMeasurement[], candidate: RunMeasurement[]) {
	const candidateByTask = new Map<string, RunMeasurement[]>();
	for (const row of candidate) {
		const queue = candidateByTask.get(row.task) ?? [];
		queue.push(row);
		candidateByTask.set(row.task, queue);
	}
	const baselinePaired: RunMeasurement[] = [];
	const candidatePaired: RunMeasurement[] = [];
	const unmatchedBaseline: string[] = [];
	for (const row of baseline) {
		const match = candidateByTask.get(row.task)?.shift();
		if (!match) {
			unmatchedBaseline.push(row.task);
			continue;
		}
		baselinePaired.push(row);
		candidatePaired.push(match);
	}
	const unmatchedCandidate = [...candidateByTask.values()].flat().map(
		(row) => row.task,
	);
	return {
		baseline: baselinePaired,
		candidate: candidatePaired,
		unmatchedBaseline,
		unmatchedCandidate,
	};
}

function main(): void {
	const [baselinePath, candidatePath] = process.argv.slice(2);
	if (!baselinePath || !candidatePath) {
		throw new Error(
			"Usage: tsx scripts/compare-hybrid-runs.ts <semantic-jsonl-or-dir> <markdown-jsonl-or-dir>",
		);
	}
	const paired = pairRuns(
		loadEntries(baselinePath).map(measureEntry),
		loadEntries(candidatePath).map(measureEntry),
	);
	const baseline = summarize(paired.baseline);
	const candidate = summarize(paired.candidate);
	const hasCompleteInputTokenCoverage =
		baseline.inputTokens.count === paired.baseline.length &&
		candidate.inputTokens.count === paired.candidate.length;
	const meanInputSaved = fractionSaved(
		hasCompleteInputTokenCoverage ? candidate.inputTokens.mean : undefined,
		hasCompleteInputTokenCoverage ? baseline.inputTokens.mean : undefined,
	);
	const medianInputSaved = fractionSaved(
		hasCompleteInputTokenCoverage
			? candidate.inputTokens.median
			: undefined,
		hasCompleteInputTokenCoverage
			? baseline.inputTokens.median
			: undefined,
	);
	const medianObservationSaved = fractionSaved(
		candidate.pageObservationTokens.median,
		baseline.pageObservationTokens.median,
	);
	process.stdout.write(
		`${JSON.stringify(
			{
				pairedTasks: paired.baseline.length,
				unmatchedBaseline: paired.unmatchedBaseline,
				unmatchedCandidate: paired.unmatchedCandidate,
				baseline,
				candidate,
				byCategory: {
					baseline: summarizeCategories(paired.baseline),
					candidate: summarizeCategories(paired.candidate),
				},
				change: {
					successRatePoints: round(
						((candidate.successRate ?? 0) -
							(baseline.successRate ?? 0)) *
							100,
					),
					meanInputTokensSaved: meanInputSaved,
					medianInputTokensSaved: medianInputSaved,
					medianPageObservationTokensSaved:
						medianObservationSaved,
				},
				launchGates: {
					successRateNoLower:
						(candidate.successRate ?? 0) >=
						(baseline.successRate ?? 0),
					meanStepsNoHigher:
						(candidate.steps.mean ?? 0) <=
						(baseline.steps.mean ?? 0),
					medianStepsNoHigher:
						(candidate.steps.median ?? 0) <=
						(baseline.steps.median ?? 0),
					meanInputTokensAtLeast20PercentLower:
						meanInputSaved === undefined
							? null
							: meanInputSaved >= 0.2,
					medianInputTokensAtLeast25PercentLower:
						medianInputSaved === undefined
							? null
							: medianInputSaved >= 0.25,
					medianPageObservationTokensAtLeast40PercentLower:
						medianObservationSaved === undefined
							? null
							: medianObservationSaved >= 0.4,
					staleOrMissingRefErrorsNoHigher:
						candidate.staleOrMissingRefErrors <=
						baseline.staleOrMissingRefErrors,
				},
			},
			null,
			2,
		)}\n`,
	);
}

main();
