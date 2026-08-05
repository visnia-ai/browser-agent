import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { main, runCli } from "../scripts/run-cli.mjs";

function childResult(code: number | null, signal: NodeJS.Signals | null) {
	const child = new EventEmitter();
	queueMicrotask(() => child.emit("exit", code, signal));
	return child;
}

test("forwards arguments and inherits standard IO", async () => {
	let invocation: unknown;
	const result = await runCli(
		"/browser-agent",
		["config.yaml", "--flag"],
		(executable, args, options) => {
			invocation = { executable, args, options };
			return childResult(0, null);
		},
	);
	assert.deepEqual(invocation, {
		executable: "/browser-agent",
		args: ["config.yaml", "--flag"],
		options: { stdio: "inherit" },
	});
	assert.deepEqual(result, { code: 0, signal: null });
});

test("preserves non-zero exits and termination signals", async () => {
	assert.deepEqual(
		await runCli("/browser-agent", [], () => childResult(23, null)),
		{ code: 23, signal: null },
	);
	assert.deepEqual(
		await runCli("/browser-agent", [], () =>
			childResult(null, "SIGTERM"),
		),
		{ code: null, signal: "SIGTERM" },
	);
});

test("reports how to recover when the executable is missing", async () => {
	let message = "";
	const result = await main({
		resolveExecutable: async () => {
			throw new Error("ENOENT");
		},
		stderr: { write: (value: string) => (message += value) },
	});
	assert.deepEqual(result, { code: 1, signal: null });
	assert.match(message, /npm install -g @visnia\/browser-agent-sdk/);
	assert.match(message, /lifecycle scripts/);
});
