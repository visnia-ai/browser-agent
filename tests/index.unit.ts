import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "mocha";
import { main, saveTaskTokenUsageAttempt } from "../src/index.js";
import { normalizeAuthCredentialsForStorage } from "../src/auth/crypto.js";
import type { Config } from "../src/utils.js";
import type {
	RunTaskInput,
	RunTaskResult,
	TokenUsageArtifactAttempt,
} from "../src/core/types.js";

function createConfig(overrides: Partial<Config> = {}): Config {
	return {
		stageLLMs: {
			findTargetURL: {
				provider: "openai",
				model: "gpt-5.4",
				reasoningEffort: "low",
			},
			createChecklist: {
				provider: "openai",
				model: "gpt-5.4",
				reasoningEffort: "low",
			},
			runAgent: {
				provider: "openai",
				model: "gpt-5.4",
				reasoningEffort: "low",
			},
			dataExtraction: {
				provider: "openai",
				model: "gpt-5.4-mini",
				reasoningEffort: "low",
			},
			verifySuccess: {
				provider: "openai",
				model: "gpt-5.4",
				reasoningEffort: "low",
			},
		},
		featureFlags: {
			preStepScreenshotInLatestUserPrompt: true,
			userTakeoverTool: true,
			authTakeover: false,
			agentTakeoverTool: false,
		},
		headless: true,
		maxSteps: 10,
		waitBetweenTasksMs: 0,
		taskRuns: 1,
		taskRunRetryCount: 0,
		concurrency: 1,
		tasks: [{ task: "upload a file" }],
		saveStepsContext: false,
		saveTaskLogs: false,
		stepMessagesJsonlPath: path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "browser-agent-main-")),
			"steps.jsonl",
		),
		...overrides,
	};
}

describe("index main", () => {
	it("atomically upserts one token usage artifact per task run", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-agent-token-usage-"),
		);
		const tokenUsageDir = path.join(root, "tokenUsage");
		const createAttempt = (
			runIndex: number,
			inputTokens: number,
		): TokenUsageArtifactAttempt => ({
			runIndex,
			retryAttempt: 1,
			completed: true,
			successful: true,
			invocations: [],
			totals: {
				input_tokens: inputTokens,
				cached_input_tokens: 0,
				reasoning_tokens: 0,
				non_reasoning_output_tokens: 1,
				output_tokens: 1,
				total_tokens: inputTokens + 1,
				generation_time_ms: 0,
			},
		});

		try {
			saveTaskTokenUsageAttempt({
				tokenUsageDir,
				taskNumber: 7,
				task: "test task",
				attempt: createAttempt(2, 20),
			});
			saveTaskTokenUsageAttempt({
				tokenUsageDir,
				taskNumber: 7,
				task: "test task",
				attempt: createAttempt(1, 10),
			});
			saveTaskTokenUsageAttempt({
				tokenUsageDir,
				taskNumber: 7,
				task: "test task",
				attempt: createAttempt(2, 30),
			});

			assert.deepEqual(fs.readdirSync(tokenUsageDir), ["task-007.json"]);
			const artifact = JSON.parse(
				fs.readFileSync(path.join(tokenUsageDir, "task-007.json"), "utf-8"),
			);
			assert.strictEqual(artifact.schemaVersion, 2);
			assert.deepEqual(
				artifact.attempts.map((attempt: TokenUsageArtifactAttempt) => ({
					runIndex: attempt.runIndex,
					inputTokens: attempt.totals.input_tokens,
				})),
				[
					{ runIndex: 1, inputTokens: 10 },
					{ runIndex: 2, inputTokens: 30 },
				],
			);
			assert.strictEqual(artifact.totals.input_tokens, 40);
			assert.strictEqual(artifact.totals.total_tokens, 42);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes independent token usage files for concurrent tasks", async () => {
		const config = createConfig({
			concurrency: 2,
			tasks: [{ task: "first task" }, { task: "second task" }],
		});
		const tokenUsageDir = path.join(
			path.dirname(config.stepMessagesJsonlPath),
			"tokenUsage",
		);
		try {
			await main(
				["node", "src/index.ts", "pipeline"],
				() => config,
				async (input) => {
					input.persistence.saveTokenUsageAttempt?.({
						runIndex: 1,
						retryAttempt: 1,
						completed: true,
						successful: true,
						invocations: [],
						totals: {
							input_tokens: input.taskNumber,
							cached_input_tokens: 0,
							reasoning_tokens: 0,
							non_reasoning_output_tokens: 0,
							output_tokens: 0,
							total_tokens: input.taskNumber,
							generation_time_ms: 0,
						},
					});
					return {
						failedRuns: [],
						runtimeFailedRuns: [],
						terminalFailedRuns: [],
						runs: [],
					};
				},
			);

			assert.deepEqual(fs.readdirSync(tokenUsageDir).sort(), [
				"task-001.json",
				"task-002.json",
			]);
			const taskIndices = fs
				.readdirSync(tokenUsageDir)
				.map((file) =>
					JSON.parse(fs.readFileSync(path.join(tokenUsageDir, file), "utf-8")),
				)
				.map((artifact) => artifact.taskIndex)
				.sort();
			assert.deepEqual(taskIndices, [1, 2]);
		} finally {
			fs.rmSync(path.dirname(config.stepMessagesJsonlPath), {
				recursive: true,
				force: true,
			});
		}
	});

	it("uses each task's own encrypted credentials", async () => {
		const firstKey = Buffer.alloc(32, 1).toString("base64");
		const secondKey = Buffer.alloc(32, 2).toString("base64");
		const credential = (
			domainUrl: string,
			username: string,
			password: string,
			encryptionKey: string,
		) =>
			normalizeAuthCredentialsForStorage(
				[{ mode: "plaintext", domainUrl, username, password }],
				{ encryptionKey },
			)!;
		const config = createConfig({
			concurrency: 2,
			tasks: [
				{
					task: "first",
					authCredentials: credential(
						"first.example.com",
						"first-user",
						"first-password",
						firstKey,
					),
					authEncryptionKey: firstKey,
				},
				{
					task: "second",
					authCredentials: credential(
						"second.example.com",
						"second-user",
						"second-password",
						secondKey,
					),
					authEncryptionKey: secondKey,
				},
			],
		});
		const usernames: string[] = [];
		try {
			await main(
				["node", "src/index.ts", "pipeline"],
				() => config,
				async (input) => {
					usernames.push(
						(await input.requestAuthIdentifierForDomain?.(
							`https://${input.task}.example.com/login`,
						)) ?? "",
					);
					return {
						failedRuns: [],
						runtimeFailedRuns: [],
						terminalFailedRuns: [],
						runs: [],
					};
				},
			);
		} finally {
			fs.rmSync(path.dirname(config.stepMessagesJsonlPath), {
				recursive: true,
				force: true,
			});
		}
		assert.deepEqual(usernames.sort(), ["first-user", "second-user"]);
	});

	it("passes configured file roots into runTask unchanged", async () => {
		const config = createConfig({
			downloadDir: "/tmp/browser-downloads",
			fileWorkspaceRoot: "/tmp/browser-workspace",
		});
		let capturedRunTaskInput: RunTaskInput | null = null;

		try {
			await main(
				["node", "src/index.ts", "pipeline"],
				() => config,
				async (input) => {
					capturedRunTaskInput = input;
					return {
						failedRuns: [],
						runtimeFailedRuns: [],
						terminalFailedRuns: [],
						runs: [],
					} satisfies RunTaskResult;
				},
			);
		} finally {
			fs.rmSync(path.dirname(config.stepMessagesJsonlPath), {
				recursive: true,
				force: true,
			});
		}

		assert.isNotNull(capturedRunTaskInput);
		assert.strictEqual(
			capturedRunTaskInput?.browserLaunch.downloadDir,
			"/tmp/browser-downloads",
		);
		assert.strictEqual(
			capturedRunTaskInput?.browserLaunch.fileWorkspaceRoot,
			"/tmp/browser-workspace",
		);
	});

	it("passes the configured task URL into runTask", async () => {
		const config = createConfig({
			tasks: [{ task: "upload a file", url: "about:blank" }],
		});
		let capturedRunTaskInput: RunTaskInput | null = null;

		try {
			await main(
				["node", "src/index.ts", "pipeline"],
				() => config,
				async (input) => {
					capturedRunTaskInput = input;
					return {
						failedRuns: [],
						runtimeFailedRuns: [],
						terminalFailedRuns: [],
						runs: [],
					} satisfies RunTaskResult;
				},
			);
		} finally {
			fs.rmSync(path.dirname(config.stepMessagesJsonlPath), {
				recursive: true,
				force: true,
			});
		}

		assert.isNotNull(capturedRunTaskInput);
		assert.strictEqual(capturedRunTaskInput?.browserLaunch.url, "about:blank");
	});

	it("passes the configured download dir unchanged for each configured task", async () => {
		const config = createConfig({
			concurrency: 2,
			downloadDir: "/tmp/browser-downloads",
			tasks: [{ task: "task one" }, { task: "task two" }],
		});
		const capturedRunTaskInputs: RunTaskInput[] = [];

		try {
			await main(
				["node", "src/index.ts", "pipeline"],
				() => config,
				async (input) => {
					capturedRunTaskInputs.push(input);
					return {
						failedRuns: [],
						runtimeFailedRuns: [],
						terminalFailedRuns: [],
						runs: [],
					} satisfies RunTaskResult;
				},
			);
		} finally {
			fs.rmSync(path.dirname(config.stepMessagesJsonlPath), {
				recursive: true,
				force: true,
			});
		}

		assert.lengthOf(capturedRunTaskInputs, 2);
		assert.deepEqual(
			capturedRunTaskInputs.map((input) => ({
				taskNumber: input.taskNumber,
				downloadDir: input.browserLaunch.downloadDir,
			})),
			[
				{
					taskNumber: 1,
					downloadDir: "/tmp/browser-downloads",
				},
				{
					taskNumber: 2,
					downloadDir: "/tmp/browser-downloads",
				},
			],
		);
	});

	it("keeps the configured download dir unchanged after resume filtering", async () => {
		const config = createConfig({
			concurrency: 2,
			downloadDir: "/tmp/browser-downloads",
			tasks: [
				{ task: "task one" },
				{ task: "task two" },
				{ task: "task three" },
			],
		});
		const completedTasksFile = path.join(
			path.dirname(config.stepMessagesJsonlPath),
			"steps.completed-tasks.json",
		);
		const capturedRunTaskInputs: RunTaskInput[] = [];

		fs.writeFileSync(completedTasksFile, JSON.stringify([2]), "utf-8");

		try {
			await main(
				["node", "src/index.ts", "pipeline"],
				() => config,
				async (input) => {
					capturedRunTaskInputs.push(input);
					return {
						failedRuns: [],
						runtimeFailedRuns: [],
						terminalFailedRuns: [],
						runs: [],
					} satisfies RunTaskResult;
				},
			);
		} finally {
			fs.rmSync(path.dirname(config.stepMessagesJsonlPath), {
				recursive: true,
				force: true,
			});
		}

		assert.lengthOf(capturedRunTaskInputs, 2);
		assert.deepEqual(
			capturedRunTaskInputs.map((input) => ({
				taskNumber: input.taskNumber,
				downloadDir: input.browserLaunch.downloadDir,
			})),
			[
				{
					taskNumber: 1,
					downloadDir: "/tmp/browser-downloads",
				},
				{
					taskNumber: 3,
					downloadDir: "/tmp/browser-downloads",
				},
			],
		);
	});

	it("allocates distinct dynamic ports per concurrent task", async () => {
		const config = createConfig({
			concurrency: 2,
			tasks: [{ task: "task one" }, { task: "task two" }],
		});
		const capturedRunTaskInputs: RunTaskInput[] = [];
		const releaseRuns: Array<() => void> = [];

		try {
			const mainPromise = main(
				["node", "src/index.ts", "pipeline"],
				() => config,
				async (input) => {
					capturedRunTaskInputs.push(input);
					await new Promise<void>((resolve) => {
						releaseRuns.push(resolve);
					});
					return {
						failedRuns: [],
						runtimeFailedRuns: [],
						terminalFailedRuns: [],
						runs: [],
					} satisfies RunTaskResult;
				},
			);

			while (capturedRunTaskInputs.length < 2) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			assert.notStrictEqual(
				capturedRunTaskInputs[0]?.browserLaunch.port,
				capturedRunTaskInputs[1]?.browserLaunch.port,
			);
			assert.isAtLeast(capturedRunTaskInputs[0]?.browserLaunch.port ?? 0, 9000);
			assert.isAtMost(capturedRunTaskInputs[0]?.browserLaunch.port ?? 0, 50000);
			assert.isAtLeast(capturedRunTaskInputs[1]?.browserLaunch.port ?? 0, 9000);
			assert.isAtMost(capturedRunTaskInputs[1]?.browserLaunch.port ?? 0, 50000);

			releaseRuns.forEach((resolve) => resolve());
			await mainPromise;
		} finally {
			fs.rmSync(path.dirname(config.stepMessagesJsonlPath), {
				recursive: true,
				force: true,
			});
		}
	});

	it("respects the configured concurrency limit while using dynamic ports", async () => {
		const config = createConfig({
			concurrency: 2,
			tasks: [
				{ task: "task one" },
				{ task: "task two" },
				{ task: "task three" },
			],
		});
		let activeRuns = 0;
		let maxActiveRuns = 0;

		try {
			await main(
				["node", "src/index.ts", "pipeline"],
				() => config,
				async () => {
					activeRuns += 1;
					maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
					await new Promise((resolve) => setTimeout(resolve, 25));
					activeRuns -= 1;
					return {
						failedRuns: [],
						runtimeFailedRuns: [],
						terminalFailedRuns: [],
						runs: [],
					} satisfies RunTaskResult;
				},
			);
		} finally {
			fs.rmSync(path.dirname(config.stepMessagesJsonlPath), {
				recursive: true,
				force: true,
			});
		}

		assert.strictEqual(maxActiveRuns, 2);
	});

	it("reports stable task IDs and forwards takeover callbacks after resume filtering", async () => {
		const config = createConfig({
			tasks: [
				{ task: "task one" },
				{ task: "task two" },
				{ task: "task three" },
			],
		});
		const completedTasksFile = path.join(
			path.dirname(config.stepMessagesJsonlPath),
			"steps.completed-tasks.json",
		);
		const takeoverTaskIds: string[] = [];
		const resultTaskIds: string[] = [];
		fs.writeFileSync(completedTasksFile, JSON.stringify([2]), "utf-8");

		try {
			await main(
				["node", "src/index.ts", "pipeline"],
				() => config,
				async (input) => {
					await input.onUserActionRequired?.({
						kind: "browser_user_takeover",
						reason: "Enter the OTP code.",
						category: "otp",
					});
					return {
						failedRuns: [],
						runtimeFailedRuns: [],
						terminalFailedRuns: [],
						runs: [
							{
								runIndex: 1,
								result: "answer: done",
								completed: true,
								successful: true,
								validator: {
									ran: true,
									success: true,
									summary: "Verified.",
								},
							},
						],
					};
				},
				{
					onUserActionRequired: ({ taskId }) => {
						takeoverTaskIds.push(taskId);
					},
					onTaskResult: ({ taskId }) => {
						resultTaskIds.push(taskId);
					},
				},
			);
		} finally {
			fs.rmSync(path.dirname(config.stepMessagesJsonlPath), {
				recursive: true,
				force: true,
			});
		}

		assert.deepEqual(takeoverTaskIds.sort(), ["task-1", "task-3"]);
		assert.deepEqual(resultTaskIds.sort(), ["task-1", "task-3"]);
	});
});
