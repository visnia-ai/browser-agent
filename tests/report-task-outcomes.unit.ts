import { assert } from "chai";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, describe, it } from "mocha";

const agentRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const reportScript = path.join(agentRoot, "scripts", "report-task-outcomes.ts");
const tempDirs: string[] = [];

interface Stats {
	count: number;
	mean: number;
	median: number;
	min: number;
	max: number;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function summarize(values: number[]): Stats {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return {
		count: values.length,
		mean: round2(
			values.reduce((sum, value) => sum + value, 0) / values.length,
		),
		median:
			sorted.length % 2 === 0
				? round2((sorted[middle - 1] + sorted[middle]) / 2)
				: sorted[middle],
		min: sorted[0],
		max: sorted.at(-1) as number,
	};
}

function writeJsonl(
	filePath: string,
	entries: Record<string, unknown>[],
): void {
	fs.writeFileSync(
		filePath,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
}

function runReport(
	jsonlDir: string,
	taskCount: number,
): Record<string, unknown> {
	const configPath = path.join(path.dirname(jsonlDir), "config.yaml");
	fs.writeFileSync(
		configPath,
		yaml.dump({
			tasks: Array.from(
				{ length: taskCount },
				(_, index) => `task-${index + 1}`,
			),
		}),
	);
	const execution = spawnSync(
		process.execPath,
		["--import=tsx", reportScript, jsonlDir, configPath, "--workers", "2"],
		{ cwd: agentRoot, encoding: "utf-8", maxBuffer: 2_000_000 },
	);
	assert.strictEqual(execution.status, 0, execution.stderr);
	return yaml.load(execution.stdout) as Record<string, unknown>;
}

describe("report-task-outcomes trajectory durations", () => {
	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("combines valid durations across files and averages successful trajectories", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "report-task-outcomes-"),
		);
		tempDirs.push(tempDir);
		const jsonlDir = path.join(tempDir, "logs");
		fs.mkdirSync(jsonlDir);

		writeJsonl(path.join(jsonlDir, "task-1.jsonl"), [
			{ successful: true, durationMs: 100, steps: [] },
			{ successful: true, durationMs: 101, steps: [] },
			{ successful: false, durationMs: 450, steps: [] },
			{ successful: false, steps: [] },
		]);
		writeJsonl(path.join(jsonlDir, "task-2.jsonl"), [
			{ successful: false, durationMs: 0, steps: [] },
			{ successful: true, durationMs: -1, steps: [] },
			{ successful: true, durationMs: "invalid", steps: [] },
			{ successful: false, durationMs: null, steps: [] },
		]);

		const report = runReport(jsonlDir, 2);
		assert.strictEqual(report.totalTrajectoryDurationMs, 651);
		assert.strictEqual(report.averageSuccessfulTrajectoryDurationMs, 100.5);
		assert.deepEqual(report.trajectoryDurationCoverage, {
			timedTrajectories: 4,
			totalTrajectories: 8,
			percentage: "50%",
			fraction: "4/8",
		});
	});

	it("reports N/A when no successful trajectory has a valid duration", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "report-task-outcomes-"),
		);
		tempDirs.push(tempDir);
		const jsonlDir = path.join(tempDir, "logs");
		fs.mkdirSync(jsonlDir);

		writeJsonl(path.join(jsonlDir, "attempts.jsonl"), [
			{ successful: false, durationMs: 500, steps: [] },
			{ successful: true, steps: [] },
			{ successful: true, durationMs: -10, steps: [] },
		]);

		const report = runReport(jsonlDir, 1);
		assert.strictEqual(report.totalTrajectoryDurationMs, 500);
		assert.strictEqual(report.averageSuccessfulTrajectoryDurationMs, "N/A");
		assert.deepEqual(report.trajectoryDurationCoverage, {
			timedTrajectories: 1,
			totalTrajectories: 3,
			percentage: "33.33%",
			fraction: "1/3",
		});
		assert.deepEqual(report.tokensPerStep, { status: "no data" });
	});
});

describe("report-task-outcomes recorded token usage", () => {
	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reports provider-recorded token totals and per-step statistics", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "report-task-outcomes-"),
		);
		tempDirs.push(tempDir);
		const jsonlDir = path.join(tempDir, "logs");
		fs.mkdirSync(jsonlDir);

		const firstEntry = {
			run: 1,
			successful: true,
			durationMs: 1_200,
			steps: [
				{
					messages: [
						{
							role: "system",
							content: [
								{ type: "text", text: "System one" },
								{
									type: "image_url",
									image_url: {
										url: `data:image/png;base64,${"A".repeat(2_000)}`,
									},
								},
							],
						},
						{
							role: "assistant",
							content: "Intermediate observation",
							reasoning_tokens:
								"Earlier reasoning is prompt-excluded",
						},
						{ role: "user", content: "Request alpha" },
						{
							role: "assistant",
							content: "done: true\nresult: alpha",
							reasoning_tokens: "Considered alpha carefully",
						},
					],
				},
				{ messages: [{ role: "user", content: "No assistant yet" }] },
			],
			trajectoryDurationMs: 1_250,
			stepRuntimeMetrics: [
				{
					totalDurationMs: 700,
					tokenGenerationMs: 500,
					browserInteractionMs: 100,
				},
				{
					totalDurationMs: 550,
					tokenGenerationMs: 350,
					browserInteractionMs: 80,
				},
			],
		};
		const secondEntry = {
			run: 2,
			successful: false,
			durationMs: 800,
			steps: [
				{
					messages: [
						{
							role: "system",
							content: [
								{ type: "text", text: "System two" },
								{
									type: "image_url",
									image_url: {
										url: "https://example.com/tiny.png",
									},
								},
							],
						},
						{ role: "user", content: "Request beta" },
						{
							role: "assistant",
							content: "done: false\nresult: beta",
							reasoning_tokens: "",
						},
					],
				},
				{ messages: [] },
			],
		};

		fs.writeFileSync(
			path.join(jsonlDir, "first.jsonl"),
			`${JSON.stringify(firstEntry)}\n`,
		);
		fs.writeFileSync(
			path.join(jsonlDir, "second.jsonl"),
			`${JSON.stringify(secondEntry)}\n`,
		);
		const tokenUsageDir = path.join(jsonlDir, "tokenUsage");
		fs.mkdirSync(tokenUsageDir);
		fs.writeFileSync(
			path.join(tokenUsageDir, "task-001.json"),
			JSON.stringify({
				schemaVersion: 1,
				attempts: [
					{
						invocations: [
							{
								usage: {
									input_tokens: 400_000,
									cached_input_tokens: 120_000,
									reasoning_tokens: 200_000,
									non_reasoning_output_tokens: 300_000,
									output_tokens: 500_000,
									total_tokens: 900_000,
								},
							},
							{
								usage: {
									input_tokens: 600_000,
									output_tokens: 700_000,
									total_tokens: 1_300_000,
								},
							},
						],
					},
				],
			}),
		);
		fs.writeFileSync(
			path.join(tokenUsageDir, "task-002.json"),
			JSON.stringify({
				schemaVersion: 1,
				attempts: [
					{
						invocations: [
							{
								usage: {
									input_tokens: 100_000,
									cached_input_tokens: 50_000,
									reasoning_tokens: 20_000,
									non_reasoning_output_tokens: 80_000,
									output_tokens: 100_000,
									total_tokens: 200_000,
								},
							},
							{
								usage: {
									input_tokens: -1,
									cached_input_tokens: -1,
									reasoning_tokens: -1,
									non_reasoning_output_tokens: -1,
									output_tokens: -1,
									total_tokens: -1,
								},
							},
						],
					},
				],
			}),
		);
		const configPath = path.join(tempDir, "config.yaml");
		fs.writeFileSync(
			configPath,
			'tasks:\n  - task: "alpha"\n    url: "https://example.com"\n  - "beta"\n',
		);

		const execution = spawnSync(
			process.execPath,
			[
				"--import=tsx",
				reportScript,
				jsonlDir,
				configPath,
				"--workers",
				"2",
			],
			{ cwd: agentRoot, encoding: "utf-8", maxBuffer: 2_000_000 },
		);
		assert.strictEqual(execution.status, 0, execution.stderr);
		const report = yaml.load(execution.stdout) as Record<string, unknown>;
		assert.deepInclude(report.successRate as Record<string, unknown>, {
			totalTaskAttempts: 2,
		});
		const inputCounts = [400_000, 600_000, 100_000];
		const cachedInputCounts = [120_000, 0, 50_000];
		const reasoningCounts = [200_000, 0, 20_000];
		const nonReasoningOutputCounts = [300_000, 700_000, 80_000];
		const outputCounts = [500_000, 700_000, 100_000];
		const totalCounts = [900_000, 1_300_000, 200_000];
		const sum = (values: number[]): number =>
			values.reduce((total, value) => total + value, 0);
		const formatted = (value: number): string =>
			value.toLocaleString("en-US");

		assert.strictEqual(
			report.totalInputTokensAcrossAllTaskSteps,
			formatted(sum(inputCounts)),
		);
		assert.strictEqual(
			report.totalOutputTokensAcrossAllTaskSteps,
			formatted(sum(outputCounts)),
		);
		assert.strictEqual(
			report.totalCachedInputTokensAcrossAllTaskSteps,
			formatted(sum(cachedInputCounts)),
		);
		assert.strictEqual(
			report.totalReasoningTokensAcrossAllTaskSteps,
			formatted(sum(reasoningCounts)),
		);
		assert.strictEqual(
			report.totalNonReasoningOutputTokensAcrossAllTaskSteps,
			formatted(sum(nonReasoningOutputCounts)),
		);
		assert.strictEqual(
			report.totalTokensAcrossAllTaskSteps,
			formatted(sum(totalCounts)),
		);
		assert.deepInclude(
			report.inputTokensPerStep as Stats,
			summarize(inputCounts),
		);
		assert.deepInclude(
			report.outputTokensPerStep as Stats,
			summarize(outputCounts),
		);
		assert.deepInclude(
			report.cachedInputTokensPerStep as Stats,
			summarize(cachedInputCounts),
		);
		assert.deepInclude(
			report.reasoningTokensPerStep as Stats,
			summarize(reasoningCounts),
		);
		assert.deepInclude(
			report.nonReasoningOutputTokensPerStep as Stats,
			summarize(nonReasoningOutputCounts),
		);
		assert.deepInclude(
			report.tokensPerStep as Stats,
			summarize(totalCounts),
		);
		assert.strictEqual(report.totalTrajectoryDurationMs, 2_000);
		assert.strictEqual(report.averageSuccessfulTrajectoryDurationMs, 1_200);
		assert.deepEqual(report.trajectoryDurationCoverage, {
			timedTrajectories: 2,
			totalTrajectories: 2,
			percentage: "100%",
			fraction: "2/2",
		});
		const timing = report.timing as Record<string, unknown>;
		assert.strictEqual(timing.coverage, "1/2");
		assert.strictEqual(timing.totalTrajectoryDurationMs, 1_250);
		assert.deepInclude(
			timing.stepDurationMs as Stats,
			summarize([700, 550]),
		);
		assert.deepInclude(
			timing.tokenGenerationMsPerStep as Stats,
			summarize([500, 350]),
		);
		assert.deepInclude(
			timing.browserInteractionMsPerStep as Stats,
			summarize([100, 80]),
		);
	});

	it("ignores missing and invalid durations and reports no successful average", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "report-task-outcomes-"),
		);
		tempDirs.push(tempDir);
		const jsonlDir = path.join(tempDir, "logs");
		fs.mkdirSync(jsonlDir);
		const entries = [
			{ run: 1, successful: false, durationMs: 500, steps: [] },
			{ run: 2, successful: false, steps: [] },
			{ run: 3, successful: true, durationMs: -1, steps: [] },
		];
		fs.writeFileSync(
			path.join(jsonlDir, "attempts.jsonl"),
			`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		const configPath = path.join(tempDir, "config.yaml");
		fs.writeFileSync(configPath, 'tasks:\n  - "alpha"\ntask_runs: 3\n');

		const execution = spawnSync(
			process.execPath,
			["--import=tsx", reportScript, jsonlDir, configPath],
			{ cwd: agentRoot, encoding: "utf-8", maxBuffer: 2_000_000 },
		);
		assert.strictEqual(execution.status, 0, execution.stderr);
		const report = yaml.load(execution.stdout) as Record<string, unknown>;

		assert.strictEqual(report.totalTrajectoryDurationMs, 500);
		assert.strictEqual(report.averageSuccessfulTrajectoryDurationMs, "N/A");
		assert.deepEqual(report.trajectoryDurationCoverage, {
			timedTrajectories: 1,
			totalTrajectories: 3,
			percentage: "33.33%",
			fraction: "1/3",
		});
	});
});
