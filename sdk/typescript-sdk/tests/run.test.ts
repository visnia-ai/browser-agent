import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOptions } from "../src/options.js";
import { createRuntimeFiles } from "../src/runtime.js";
import { BrowserAgentRunImpl } from "../src/run.js";
import { createAgent, withMode } from "./helpers.js";

test("resolves explicit and early cancellation idempotently", async () => {
	await withMode("wait", async () => {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const run = createAgent().run(
			{ task: "wait" },
			{
				onEvent: (event) => {
					if (event.type === "run_started") started();
				},
			},
		);
		await ready;
		await Promise.all([run.cancel(), run.cancel()]);
		assert.equal((await run.result).status, "cancelled");
	});

	let resolve!: (value: string) => void;
	const executable = new Promise<string>((done) => {
		resolve = done;
	});
	const agent = createAgent({}, [], {
		resolve: () => executable,
		verify: async () => undefined,
	});
	const run = agent.run({ task: "early" });
	const cancelled = run.cancel();
	resolve("/unused");
	await cancelled;
	assert.equal((await run.result).status, "cancelled");

	let setupStarted!: () => void;
	let finishSetup!: () => void;
	const setup = new Promise<void>((resolve) => {
		setupStarted = resolve;
	});
	const continueSetup = new Promise<void>((resolve) => {
		finishSetup = resolve;
	});
	const options = resolveOptions({
		provider: "openai",
		model: "gpt-5.4",
		apiKey: "key",
		downloadDirectory: path.join(os.tmpdir(), "ts-run-downloads"),
	});
	const afterVerification = new BrowserAgentRunImpl(
		"setup",
		options,
		[{ task: "during setup" }],
		{},
		Promise.resolve("/unused"),
		async (...arguments_) => {
			setupStarted();
			await continueSetup;
			return createRuntimeFiles(...arguments_);
		},
	);
	await setup;
	const cancellation = afterVerification.cancel();
	finishSetup();
	await cancellation;
	assert.equal((await afterVerification.result).status, "cancelled");
	fs.rmSync(options.downloadDirectory, { recursive: true, force: true });
});

test("isolates event callbacks and reports successful completion", async () => {
	await withMode("success", async () => {
		const run = createAgent().run(
			{ task: "ok" },
			{
				onEvent: () => {
					throw new Error("consumer");
				},
			},
		);
		assert.equal((await run.result).status, "completed");
		const keyless = createAgent({
			provider: "vllm",
			model: "qwen",
			apiKey: undefined,
			endpointUrl: "http://localhost:8000",
		});
		assert.equal(
			(await keyless.run({ task: "ok" }).result).status,
			"completed",
		);
		const agent = createAgent();
		const [first, second] = await Promise.all([
			agent.run({ task: "first concurrent" }).result,
			agent.run({ task: "second concurrent" }).result,
		]);
		assert.notEqual(first.runId, second.runId);
	});
});

test("rejects every protocol, RPC, and process failure path", async () => {
	const cases = [
		["malformed", "PROTOCOL_ERROR"],
		["invalid-message", "PROTOCOL_ERROR"],
		["invalid-ack", "PROTOCOL_ERROR"],
		["reject", "CHROME_NOT_FOUND"],
		["rpc-error", "PROCESS_EXITED"],
		["early-exit", "PROCESS_EXITED"],
		["nonzero-complete", "PROCESS_EXITED"],
		["incomplete", "PROTOCOL_ERROR"],
	] as const;
	for (const [mode, code] of cases) {
		await withMode(mode, async () => {
			const run = createAgent().run(
				mode === "incomplete"
					? [{ task: "one" }, { task: "two" }]
					: { task: "one" },
			);
			await assert.rejects(run.result, { code });
			const events = [];
			for await (const event of run.events()) events.push(event);
			assert.equal(events.at(-1)?.type, "error");
		});
	}

	const failedSpawn = new BrowserAgentRunImpl(
		"failed-spawn",
		resolveOptions({
			provider: "openai",
			model: "gpt-5.4",
			apiKey: "key",
			downloadDirectory: os.tmpdir(),
		}),
		[{ task: "one" }],
		{},
		Promise.resolve(path.join(os.tmpdir(), "missing-browser-agent")),
	);
	await assert.rejects(failedSpawn.result, { code: "PROCESS_START_FAILED" });
});
