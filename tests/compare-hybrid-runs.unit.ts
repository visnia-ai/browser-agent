import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const tempDirs: string[] = [];

describe("compare-hybrid-runs", () => {
	afterEach(() => {
		for (const directory of tempDirs.splice(0)) {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("pairs tasks and evaluates the MVP launch gates", () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "compare-hybrid-runs-"),
		);
		tempDirs.push(directory);
		const baselinePath = path.join(directory, "semantic.jsonl");
		const candidatePath = path.join(directory, "markdown.jsonl");
		const entry = (input: {
			observationKey: "projection" | "pageObservation";
			observation: string;
			inputTokens: number;
			steps: number;
			metrics?: Record<string, number>;
		}) => ({
			task: "Find the result",
			successful: true,
			browserEquivalentSteps: input.steps,
			steps: [
				{
					messages: [
						{
							role: "user",
							content: `task: Find the result\ncurrentURL: https://example.com\n${input.observationKey}: |\n  ${input.observation}`,
						},
					],
				},
			],
			modelInvocations: [
				{ usage: { input_tokens: input.inputTokens } },
			],
			pageObservationMetrics: input.metrics,
		});
		fs.writeFileSync(
			baselinePath,
			`${JSON.stringify(
				entry({
					observationKey: "projection",
					observation: "semantic baseline content repeated repeated",
					inputTokens: 1_000,
					steps: 2,
				}),
			)}\n`,
		);
		fs.writeFileSync(
			candidatePath,
			`${JSON.stringify(
				entry({
					observationKey: "pageObservation",
					observation: "# Result",
					inputTokens: 700,
					steps: 2,
					metrics: {
						totalReads: 2,
						bootstrapReads: 1,
						wholePageReads: 1,
						batchedReads: 1,
					},
				}),
			)}\n`,
		);

		const execution = spawnSync(
			process.execPath,
			[
				"--import=tsx",
				path.resolve("scripts/compare-hybrid-runs.ts"),
				baselinePath,
				candidatePath,
			],
			{ encoding: "utf8" },
		);
		assert.strictEqual(execution.status, 0, execution.stderr);
		const report = JSON.parse(execution.stdout) as Record<string, any>;
		assert.strictEqual(report.pairedTasks, 1);
		assert.strictEqual(report.change.meanInputTokensSaved, 0.3);
		assert.isTrue(report.launchGates.successRateNoLower);
		assert.isTrue(
			report.launchGates.meanInputTokensAtLeast20PercentLower,
		);
		assert.deepInclude(report.candidate.readDiagnostics, {
			totalReads: 2,
			bootstrapReads: 1,
			wholePageReads: 1,
			batchedReads: 1,
		});
	});

	it("prefers complete task token artifacts over auxiliary invocation totals", () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "compare-hybrid-token-usage-"),
		);
		tempDirs.push(directory);
		for (const [mode, inputTokens] of [
			["semantic", 2_000],
			["markdown", 1_000],
		] as const) {
			const modeDirectory = path.join(directory, mode);
			fs.mkdirSync(path.join(modeDirectory, "tokenUsage"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(modeDirectory, "steps-task-001.jsonl"),
				`${JSON.stringify({
					task: "Token task",
					successful: true,
					browserEquivalentSteps: 1,
					steps: [],
					modelInvocations: [{ usage: { input_tokens: 10 } }],
				})}\n`,
			);
			fs.writeFileSync(
				path.join(modeDirectory, "tokenUsage", "task-001.json"),
				`${JSON.stringify({ totals: { input_tokens: inputTokens } })}\n`,
			);
		}

		const execution = spawnSync(
			process.execPath,
			[
				"--import=tsx",
				path.resolve("scripts/compare-hybrid-runs.ts"),
				path.join(directory, "semantic"),
				path.join(directory, "markdown"),
			],
			{ encoding: "utf8" },
		);
		assert.strictEqual(execution.status, 0, execution.stderr);
		const report = JSON.parse(execution.stdout) as Record<string, any>;
		assert.strictEqual(report.baseline.inputTokens.mean, 2_000);
		assert.strictEqual(report.candidate.inputTokens.mean, 1_000);
		assert.strictEqual(report.change.meanInputTokensSaved, 0.5);
	});
});
