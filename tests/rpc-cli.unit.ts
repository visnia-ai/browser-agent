import { assert } from "chai";
import { Readable, Writable } from "node:stream";
import { describe, it } from "mocha";
import { main } from "../src/index.js";
import { decryptAuthField } from "../src/auth/crypto.js";
import { runRpcStdio } from "../src/rpc.js";
import type { Config } from "../src/utils.js";

function captureStream(): {
	stream: Writable;
	read: () => string;
} {
	let text = "";
	return {
		stream: new Writable({
			write(chunk, _encoding, callback) {
				text += chunk.toString();
				callback();
			},
		}),
		read: () => text,
	};
}

function parseMessages(text: string): Array<Record<string, any>> {
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, any>);
}

function rpcConfig(): Config {
	return {
		tasks: [{ task: "test task" }],
	} as Config;
}

describe("RPC CLI", () => {
	it("encrypts per-task plaintext credentials before main receives config", async () => {
		const output = captureStream();
		const username = "sdk-user@example.com";
		const password = "sdk password";
		const domain = "login.example.com";
		const credentials = [
			{ username, password, domain },
			{
				username: "backup@example.com",
				password: "backup password",
				domain: "backup.example.com",
			},
		];
		const fakeMain = (async (_argv, loadConfig) => {
			const config = loadConfig!("pipeline");
			const task = config.tasks[0]!;
			assert.lengthOf(task.authCredentials ?? [], credentials.length);
			assert.isString(task.authEncryptionKey);
			for (const [index, credential] of credentials.entries()) {
				const stored = task.authCredentials![index]!;
				assert.notInclude(JSON.stringify(config), credential.username);
				assert.notInclude(JSON.stringify(config), credential.password);
				assert.notInclude(JSON.stringify(config), credential.domain);
				assert.strictEqual(
					decryptAuthField(stored.encryptedUsername, {
						encryptionKey: task.authEncryptionKey,
					}),
					credential.username,
				);
				assert.strictEqual(
					decryptAuthField(stored.encryptedPassword, {
						encryptionKey: task.authEncryptionKey,
					}),
					credential.password,
				);
				assert.strictEqual(
					decryptAuthField(stored.encryptedDomainUrl, {
						encryptionKey: task.authEncryptionKey,
					}),
					credential.domain,
				);
			}
			assert.isTrue(config.featureFlags.authTakeover);
		}) as typeof main;

		const succeeded = await runRpcStdio({
			argv: ["node", "src/cli.ts", "pipeline", "--rpc"],
			configPath: "pipeline",
			loadConfig: rpcConfig,
			input: Readable.from([
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "browser-agent/run",
					params: {
						tasks: [
							{
								credentials,
							},
						],
					},
				})}\n`,
			]),
			output: output.stream,
			errorStream: captureStream().stream,
			mainFn: fakeMain,
			resolveChromePath: () => "/fake/chrome",
		});

		assert.isTrue(succeeded);
		assert.strictEqual(parseMessages(output.read())[0]?.result.accepted, true);
	});

	it("rejects malformed per-task credentials without echoing values", async () => {
		const output = captureStream();
		const succeeded = await runRpcStdio({
			argv: ["node", "src/cli.ts", "pipeline", "--rpc"],
			configPath: "pipeline",
			loadConfig: rpcConfig,
			input: Readable.from([
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "browser-agent/run",
					params: {
						tasks: [
							{
								credentials: [
									{
										username: "",
										password: "must-not-leak",
										domain: "example.com",
									},
								],
							},
						],
					},
				})}\n`,
			]),
			output: output.stream,
			errorStream: captureStream().stream,
			mainFn: (async () => assert.fail("main should not run")) as typeof main,
			resolveChromePath: () => "/fake/chrome",
		});

		assert.isFalse(succeeded);
		const response = parseMessages(output.read())[0]!;
		assert.strictEqual(response.error.data.code, "CONFIG_INVALID");
		assert.notInclude(JSON.stringify(response), "must-not-leak");
	});

	it("acknowledges one run and streams takeover, task result, and completion", async () => {
		const output = captureStream();
		const errors = captureStream();
		const fakeMain = (async (_argv, _loadConfig, _runTask, lifecycle) => {
			console.log("human log");
			console.info("human info");
			await lifecycle?.onUserActionRequired?.({
				taskId: "task-2",
				kind: "browser_user_takeover",
				reason: "Enter the OTP code.",
				category: "otp",
			});
			assert.include(output.read(), '"method":"browser-agent/status"');
			await lifecycle?.onTaskResult?.({
				taskId: "task-2",
				status: "completed",
				runs: [
					{
						runIndex: 1,
						result: "- answer: done",
						completed: true,
						successful: true,
						validator: {
							ran: true,
							success: true,
							summary: "Verified.",
						},
					},
				],
				errors: [],
			});
		}) as typeof main;

		const succeeded = await runRpcStdio({
			argv: ["node", "src/cli.ts", "pipeline", "--rpc"],
			configPath: "pipeline",
			loadConfig: rpcConfig,
			input: Readable.from([
				'{"jsonrpc":"2.0","id":"run-1","method":"browser-agent/run","params":{}}\n',
			]),
			output: output.stream,
			errorStream: errors.stream,
			mainFn: fakeMain,
			resolveChromePath: () => "/fake/chrome",
		});

		assert.isTrue(succeeded);
		assert.include(errors.read(), "human log");
		assert.include(errors.read(), "human info");
		const messages = parseMessages(output.read());
		assert.deepEqual(messages[0], {
			jsonrpc: "2.0",
			id: "run-1",
			result: { accepted: true },
		});
		assert.deepInclude(messages[1], {
			jsonrpc: "2.0",
			method: "browser-agent/status",
			params: {
				task_id: "task-2",
				status: "user_takeover",
				reason: "Enter the OTP code.",
				category: "otp",
			},
		});
		assert.deepEqual(messages[2], {
			jsonrpc: "2.0",
			method: "browser-agent/task_result",
			params: {
				task_id: "task-2",
				status: "completed",
				runs: [
					{
						run_index: 1,
						yaml_result: "- answer: done",
						data: [{ answer: "done" }],
						completed: true,
						successful: true,
						validator: {
							ran: true,
							success: true,
							summary: "Verified.",
						},
					},
				],
			},
		});
		assert.deepEqual(messages[3], {
			jsonrpc: "2.0",
			method: "browser-agent/all_tasks_completed",
			params: {},
		});
	});

	it("returns protocol errors until it receives a valid run request", async () => {
		const output = captureStream();
		const succeeded = await runRpcStdio({
			argv: ["node", "src/cli.ts", "--rpc"],
			configPath: "pipeline",
			loadConfig: rpcConfig,
			input: Readable.from([
				"{bad json}\n",
				'{"jsonrpc":"2.0","id":2,"method":"browser-agent/unknown"}\n',
				'{"jsonrpc":"2.0","id":3,"method":"browser-agent/run"}\n',
			]),
			output: output.stream,
			errorStream: captureStream().stream,
			mainFn: (async () => {}) as typeof main,
			resolveChromePath: () => "/fake/chrome",
		});

		assert.isTrue(succeeded);
		const messages = parseMessages(output.read());
		assert.strictEqual(messages[0]?.error.code, -32700);
		assert.strictEqual(messages[1]?.id, 2);
		assert.strictEqual(messages[1]?.error.code, -32601);
		assert.deepEqual(messages[2], {
			jsonrpc: "2.0",
			id: 3,
			result: { accepted: true },
		});
		assert.strictEqual(
			messages[3]?.method,
			"browser-agent/all_tasks_completed",
		);
	});

	it("returns an invalid-params error when config loading fails", async () => {
		const output = captureStream();
		const succeeded = await runRpcStdio({
			argv: ["node", "src/cli.ts", "--rpc"],
			configPath: "missing",
			loadConfig: () => {
				throw new Error("Config file not found.");
			},
			input: Readable.from([
				'{"jsonrpc":"2.0","id":9,"method":"browser-agent/run"}\n',
			]),
			output: output.stream,
			errorStream: captureStream().stream,
			resolveChromePath: () => "/fake/chrome",
			mainFn: (async () => {
				assert.fail("main should not run");
			}) as typeof main,
		});

		assert.isFalse(succeeded);
		assert.deepEqual(parseMessages(output.read()), [
			{
				jsonrpc: "2.0",
				id: 9,
				error: {
					code: -32602,
					message: "Config file not found.",
					data: { code: "CONFIG_INVALID" },
				},
			},
		]);
	});

	it("rejects RPC configs without tasks instead of prompting on stdin", async () => {
		const output = captureStream();
		const succeeded = await runRpcStdio({
			argv: ["node", "src/cli.ts", "--rpc"],
			configPath: "pipeline",
			loadConfig: () => ({ tasks: [] }) as unknown as Config,
			input: Readable.from([
				'{"jsonrpc":"2.0","id":10,"method":"browser-agent/run"}\n',
			]),
			output: output.stream,
			errorStream: captureStream().stream,
			resolveChromePath: () => "/fake/chrome",
			mainFn: (async () => {
				assert.fail("main should not run");
			}) as typeof main,
		});

		assert.isFalse(succeeded);
		assert.deepEqual(parseMessages(output.read()), [
			{
				jsonrpc: "2.0",
				id: 10,
				error: {
					code: -32602,
					message: "RPC mode requires at least one configured task.",
					data: { code: "CONFIG_INVALID" },
				},
			},
		]);
	});

	it("returns a structured error when Chrome cannot be resolved", async () => {
		const output = captureStream();
		const succeeded = await runRpcStdio({
			argv: ["node", "src/cli.ts", "--rpc"],
			configPath: "pipeline",
			loadConfig: rpcConfig,
			input: Readable.from([
				'{"jsonrpc":"2.0","id":11,"method":"browser-agent/run"}\n',
			]),
			output: output.stream,
			errorStream: captureStream().stream,
			resolveChromePath: () => {
				throw new Error("missing");
			},
		});

		assert.isFalse(succeeded);
		assert.deepEqual(parseMessages(output.read()), [
			{
				jsonrpc: "2.0",
				id: 11,
				error: {
					code: -32000,
					message: "Chrome executable was not found.",
					data: { code: "CHROME_NOT_FOUND" },
				},
			},
		]);
	});

	it("prepares provider authentication before accepting the run and cleans it up", async () => {
		const output = captureStream();
		let prepared = false;
		let cleanedUp = false;
		const succeeded = await runRpcStdio({
			argv: ["node", "src/cli.ts", "pipeline", "--rpc"],
			configPath: "pipeline",
			loadConfig: rpcConfig,
			input: Readable.from([
				'{"jsonrpc":"2.0","id":12,"method":"browser-agent/run"}\n',
			]),
			output: output.stream,
			errorStream: captureStream().stream,
			resolveChromePath: () => "/fake/chrome",
			prepareRun: async () => {
				assert.strictEqual(output.read(), "");
				prepared = true;
				return () => {
					cleanedUp = true;
				};
			},
			mainFn: (async () => {
				assert.isTrue(prepared);
			}) as typeof main,
		});

		assert.isTrue(succeeded);
		assert.isTrue(cleanedUp);
		assert.strictEqual(parseMessages(output.read())[0]?.result.accepted, true);
	});

	it("returns a pre-acceptance error when provider authentication fails", async () => {
		const output = captureStream();
		const succeeded = await runRpcStdio({
			argv: ["node", "src/cli.ts", "pipeline", "--rpc"],
			configPath: "pipeline",
			loadConfig: rpcConfig,
			input: Readable.from([
				'{"jsonrpc":"2.0","id":13,"method":"browser-agent/run"}\n',
			]),
			output: output.stream,
			errorStream: captureStream().stream,
			resolveChromePath: () => "/fake/chrome",
			prepareRun: async () => {
				throw new Error("Codex login failed.");
			},
			mainFn: (async () => {
				assert.fail("main should not run");
			}) as typeof main,
		});

		assert.isFalse(succeeded);
		assert.deepEqual(parseMessages(output.read()), [
			{
				jsonrpc: "2.0",
				id: 13,
				error: {
					code: -32001,
					message: "Codex login failed.",
					data: { code: "CODEX_AUTH_FAILED" },
				},
			},
		]);
	});
});
