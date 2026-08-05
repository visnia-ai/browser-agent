import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	consumeLogs,
	requestRun,
	startAgentProcess,
	terminateProcess,
	type AgentProcess,
} from "../src/protocol.js";
import { fakeExecutable } from "./helpers.js";

function config(): string {
	const file = path.join(
		os.tmpdir(),
		`sdk-config-${Date.now()}-${Math.random()}`,
	);
	fs.writeFileSync(file, JSON.stringify({ tasks: [] }));
	return file;
}

test("starts RPC, writes the run request, skips blanks, and reads logs", async () => {
	const file = config();
	try {
		const agentProcess = startAgentProcess(fakeExecutable, file, {
			...globalThis.process.env,
			SDK_FAKE_MODE: "success",
		});
		requestRun(agentProcess);
		const messages = [];
		for await (const message of agentProcess.messages)
			messages.push(message);
		const logs = [];
		for await (const line of agentProcess.logs) logs.push(line);
		assert.equal(messages[0]?.id, 1);
		assert(logs.length > 0);
		assert.equal((await agentProcess.exit).code, 0);
		await terminateProcess(agentProcess);
	} finally {
		fs.rmSync(file, { force: true });
	}
});

test("redacts logs and isolates callback failures", async () => {
	const entries: string[] = [];
	const process = {
		logs: (async function* () {
			yield "secret /private";
			yield "second";
		})(),
	} as AgentProcess;
	await consumeLogs(
		process,
		"run",
		(entry) => {
			entries.push(entry.message);
			if (entries.length === 2) throw new Error("consumer");
		},
		["secret"],
		["/private"],
	);
	assert.deepEqual(entries, ["<redacted> <internal>", "second"]);
	await consumeLogs(
		{
			logs: (async function* () {
				yield "ignored";
			})(),
		} as AgentProcess,
		"run",
		undefined,
		[],
		[],
	);
});

test("rejects malformed and invalid JSON-RPC messages", async () => {
	for (const mode of ["malformed", "invalid-message"]) {
		const file = config();
		const process = startAgentProcess(fakeExecutable, file, {
			...globalThis.process.env,
			SDK_FAKE_MODE: mode,
		});
		requestRun(process);
		await assert.rejects(
			async () => {
				for await (const _ of process.messages) void _;
			},
			{ code: "PROTOCOL_ERROR" },
		);
		await terminateProcess(process);
		fs.rmSync(file, { force: true });
	}
});

test("reports process start failures and uses forced termination fallback", async () => {
	const missing = startAgentProcess("/definitely/missing", "config", {});
	await assert.rejects(missing.exit, { code: "PROCESS_START_FAILED" });

	const signals: string[] = [];
	let finish!: () => void;
	const exit = new Promise<{ code: number; signal: null }>((resolve) => {
		finish = () => resolve({ code: 1, signal: null });
	});
	const fake = {
		child: {
			exitCode: null,
			signalCode: null,
			kill: (signal: string) => {
				signals.push(signal);
				if (signal === "SIGKILL") {
					fake.child.exitCode = 1;
					finish();
				}
				return true;
			},
		},
		exit,
	} as unknown as AgentProcess;
	await terminateProcess(fake, 1);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

	const exited = {
		child: { exitCode: 0, signalCode: null },
	} as unknown as AgentProcess;
	await terminateProcess(exited);
});
