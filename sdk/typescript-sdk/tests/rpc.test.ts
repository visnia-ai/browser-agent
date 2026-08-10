import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserAgentEvent } from "../src/types.js";
import type { RpcMessage } from "../src/protocol.js";
import { RpcState } from "../src/rpc.js";

const valid = {
	task_id: "task-2",
	status: "completed",
	runs: [
		{
			run_index: 1,
			completed: true,
			data: 0,
			validator: { ran: false, success: true, summary: "ok" },
		},
	],
	errors: ["one", 2],
};

function consume(...messages: RpcMessage[]) {
	const events: BrowserAgentEvent[] = [];
	const rpc = new RpcState("run", ["secret"], ["/private"]);
	let completed = false;
	let failure: unknown;
	try {
		for (const message of messages) {
			const event = rpc.handle(message);
			if (event === "complete") completed = true;
			else if (event) events.push(event);
		}
	} catch (error) {
		failure = error;
	}
	return { events, completed, failure, rpc };
}

test("normalizes, orders, and emits RPC results", () => {
	const output = consume(
		{ jsonrpc: "2.0", id: 1, result: { accepted: true } },
		{ jsonrpc: "2.0", method: "ignored" },
		{
			jsonrpc: "2.0",
			method: "browser-agent/status",
			params: { category: "payment" },
		},
		{ jsonrpc: "2.0", method: "browser-agent/status", params: null },
		{ jsonrpc: "2.0", method: "browser-agent/task_result", params: valid },
		{
			jsonrpc: "2.0",
			method: "browser-agent/task_result",
			params: {
				...valid,
				task_id: "task-3",
				runs: [{ ...valid.runs[0], data: undefined }],
			},
		},
		{
			jsonrpc: "2.0",
			method: "browser-agent/task_result",
			params: { ...valid, task_id: "custom", errors: null },
		},
		{ jsonrpc: "2.0", method: "browser-agent/all_tasks_completed" },
	);
	assert.equal(output.completed, true);
	assert.equal(output.failure, undefined);
	assert.deepEqual(
		output.events.map((event) => event.type),
		[
			"run_started",
			"user_takeover",
			"user_takeover",
			"task_result",
			"task_result",
			"task_result",
		],
	);
	assert.deepEqual(
		output.rpc.results.map((item) => item.taskId),
		["task-2", "task-3", "custom"],
	);
	const task = output.rpc.results[0]!;
	assert.equal(task.runs[0]?.data, 0);
	assert.deepEqual(task.errors, ["one"]);
	assert.equal(output.rpc.results[1]?.runs[0]?.data, null);
});

test("rejects malformed result and run records", () => {
	for (const value of [
		null,
		[],
		{},
		{ ...valid, task_id: 1 },
		{ ...valid, status: "pending" },
		{ ...valid, runs: null },
		{ ...valid, runs: [null] },
		{ ...valid, runs: [{ validator: null }] },
		{
			...valid,
			runs: [
				{
					run_index: "1",
					completed: true,
					validator: { ran: true, success: true, summary: "" },
				},
			],
		},
	]) {
		assert.equal(
			(
				consume({
					jsonrpc: "2.0",
					method: "browser-agent/task_result",
					params: value,
				}).failure as { code: string }
			).code,
			"PROTOCOL_ERROR",
		);
	}
});

test("maps rejection codes and redacts infrastructure errors", () => {
	for (const [code, expected] of [
		["CONFIG_INVALID", "CONFIG_INVALID"],
		["CHROME_NOT_FOUND", "CHROME_NOT_FOUND"],
		["CODEX_AUTH_FAILED", "CODEX_AUTH_FAILED"],
		["UNKNOWN", "PROTOCOL_ERROR"],
		[undefined, "PROTOCOL_ERROR"],
	] as const) {
		const output = consume({
			jsonrpc: "2.0",
			id: 1,
			error: {
				message: "secret /private",
				data: code ? { code } : undefined,
			},
		});
		assert.equal((output.failure as { code: string }).code, expected);
		assert.equal(
			(output.failure as Error).message,
			"<redacted> <internal>",
		);
	}
	assert.equal(
		(consume({ jsonrpc: "2.0", id: 1, result: {} }).failure as Error)
			.message,
		"CLI did not accept the run.",
	);
	assert.equal(
		(consume({ jsonrpc: "2.0", id: 1, error: {} }).failure as Error)
			.message,
		"CLI rejected the run.",
	);
	assert.equal(
		(
			consume({ jsonrpc: "2.0", method: "browser-agent/error", params: null })
				.failure as Error
		).message,
		"browser-agent failed.",
	);
});
