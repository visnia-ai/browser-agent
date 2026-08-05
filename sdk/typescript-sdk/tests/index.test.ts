import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { BrowserAgent, BrowserAgentError } from "../src/index.js";
import type { BrowserAgentEvent } from "../src/types.js";
import { createAgent, withCapture, withMode } from "./helpers.js";

test("exports the documented package-root API", async () => {
	const sdk = await import("../src/index.js");
	assert.deepEqual(Object.keys(sdk).sort(), [
		"BrowserAgent",
		"BrowserAgentError",
	]);
});

test("validates construction and run input synchronously", () => {
	assert.throws(
		() =>
			new BrowserAgent({
				provider: "unknown" as "openai",
				model: "model",
				downloadDirectory: ".",
			}),
		(error) =>
			error instanceof BrowserAgentError &&
			error.code === "CONFIG_INVALID",
	);
	const agent = createAgent();
	assert.throws(() => agent.run([]), { code: "CONFIG_INVALID" });
});

test("runs tasks, replays events, applies defaults, and verifies once", async () => {
	await withMode("success", () =>
		withCapture(async (capture, versions) => {
			const logs: string[] = [];
			const agent = createAgent({}, logs);
			const run = agent.run([
				{
					task: "first",
					credentials: [
						{
							username: "sdk-user@example.com",
							password: "sdk-password",
							domain: "login.example.com",
						},
						{
							username: "backup-user@example.com",
							password: "backup-password",
							domain: "backup.example.com",
						},
					],
				},
				{ task: "fail second" },
			]);
			const result = await run.result;
			assert.equal(result.status, "failed");
			assert.deepEqual(
				result.tasks.map((task) => task.taskId),
				["task-1", "task-2"],
			);
			const first: BrowserAgentEvent[] = [];
			for await (const event of run.events()) first.push(event);
			const replayed: BrowserAgentEvent[] = [];
			for await (const event of run.events()) replayed.push(event);
			assert.deepEqual(replayed, first);
			assert.equal(first[0]?.type, "run_started");
			assert.equal(first.at(-1)?.type, "run_completed");

			const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
			assert.equal(
				captured.config.stage_llms.runAgent.reasoning_effort,
				"low",
			);
			assert.equal(captured.config.headless, false);
			assert.equal(captured.config.concurrency, 8);
			assert.equal(captured.config.task_run_retry_count, 2);
			assert.equal(
				JSON.stringify(captured.config).includes("sdk-secret"),
				false,
			);
			assert.equal(
				JSON.stringify(captured.config).includes("sdk-password"),
				false,
			);
			assert.deepEqual(captured.requestCredentialCounts, [2, 0]);
			assert.deepEqual(captured.environment, {
				OPENAI_API_KEY: "sdk-secret",
			});
			assert.equal(
				fs.existsSync(captured.config.file_workspace_root),
				false,
			);
			assert(logs.some((line) => line.includes("<redacted>")));
			assert(logs.some((line) => line.includes("<internal>")));
			assert.equal(
				logs.some((line) => line.includes("sdk-password")),
				false,
			);
			assert.equal(
				logs.some((line) => line.includes("backup-password")),
				false,
			);
			assert.equal(
				JSON.stringify(result).includes("sdk-password"),
				false,
			);
			assert.equal(
				JSON.stringify(result).includes("backup-password"),
				false,
			);
			assert(
				result.tasks[0]?.errors.every((error) =>
					error.includes("<redacted>"),
				),
			);

			await agent.run({ task: "again" }).result;
			assert.equal(
				fs.readFileSync(versions, "utf8").trim().split("\n").length,
				1,
			);
		}),
	);
});

test("caches a rejected executable verification", async () => {
	let resolutions = 0;
	const agent = createAgent({}, [], {
		resolve: async () => {
			resolutions += 1;
			return "missing";
		},
		verify: async () => {
			throw new BrowserAgentError("CLI_NOT_FOUND", "missing");
		},
	});
	await assert.rejects(agent.run({ task: "one" }).result, {
		code: "CLI_NOT_FOUND",
	});
	await assert.rejects(agent.run({ task: "two" }).result, {
		code: "CLI_NOT_FOUND",
	});
	assert.equal(resolutions, 1);
});
