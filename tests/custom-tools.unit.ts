import { assert } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileCustomTools } from "../src/custom-tools.js";
import { getExecutorSystem } from "../src/agents/prompts.js";
import { normalizeActionListWithDiagnostics } from "../src/agents/executor-utils/action-normalization.js";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import type { Browser } from "../src/browser/types.js";
import { buildActionSignatureWithUrl } from "../src/core/run-agent-loop-state.js";

function registry(javascript = "async ({ args }) => ({ echoed: args.value })") {
	return compileCustomTools([
		{
			name: "echo_value",
			description: "Echo a value from the active page.",
			arguments: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
				additionalProperties: false,
			},
			javascript,
		},
	]);
}

function browserClient() {
	const calls: Array<Record<string, unknown>> = [];
	const client = {
		send: async (method: string, params: Record<string, unknown>) => {
			calls.push({ method, params });
			return { method, params };
		},
	};
	const browser = {
		client,
	} as unknown as Browser;
	return { browser, calls };
}

function memoryFiles() {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "browser-agent-custom-tool-"),
	);
	const memoryFile = path.join(directory, "memory");
	const resultFile = path.join(directory, "memory-result");
	fs.writeFileSync(memoryFile, "", "utf-8");
	fs.writeFileSync(resultFile, "", "utf-8");
	return { directory, memoryFile, resultFile };
}

describe("SDK custom tools", () => {
	it("validates definitions, collisions, and schemas", () => {
		assert.throws(
			() =>
				compileCustomTools([
					{
						name: "click",
						description: "bad",
						arguments: { type: "object" },
						javascript: "() => true",
					},
				]),
			/collides with a built-in/,
		);
		assert.throws(
			() =>
				compileCustomTools([
					{
						name: "bad-name",
						description: "bad",
						arguments: { type: "object" },
						javascript: "() => true",
					},
				]),
			/name must match/,
		);
	});

	it("adds only public metadata to the prompt when configured", () => {
		const base = getExecutorSystem();
		assert.notInclude(base, "### Custom Tools");
		const prompt = getExecutorSystem({
			customTools: registry("() => 'SECRET_SOURCE'"),
		});
		assert.include(prompt, "### Custom Tools");
		assert.include(prompt, "echo_value");
		assert.include(prompt, '"required"');
		assert.notInclude(prompt, "SECRET_SOURCE");
	});

	it("normalizes valid calls and rejects invalid arguments", () => {
		const tools = registry();
		assert.deepEqual(
			normalizeActionListWithDiagnostics(
				[{ echo_value: { value: "hello" } }],
				tools,
			),
			{
				status: "accepted",
				actions: [
					{
						type: "custom_tool",
						name: "echo_value",
						arguments: { value: "hello" },
					},
				],
				diagnostics: [],
			},
		);
		const invalid = normalizeActionListWithDiagnostics(
			[{ echo_value: { value: 42 } }],
			tools,
		);
		assert.equal(invalid.status, "rejected");
		if (invalid.status === "rejected") {
			assert.match(invalid.diagnostics[0], /must be string/);
		}
	});

	it("executes host functions with args and the active CDP client", async () => {
		const { browser, calls } = browserClient();
		const result = await executeActions({
			b: browser,
			actions: [
				{
					type: "custom_tool",
					name: "echo_value",
					arguments: { value: "hello" },
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-custom-tool-test-memory",
			customTools: registry(
				"async ({ args, cdp }) => ({ echoed: args.value, cdp: await cdp.send('Runtime.evaluate', { expression: 'document.title' }) })",
			),
		});
		assert.deepEqual(result.interactionErrors, []);
		assert.include(result.toolObservations[0], '"echoed":"hello"');
		assert.deepEqual(calls, [
			{
				method: "Runtime.evaluate",
				params: { expression: "document.title" },
			},
		]);
	});

	it("executes multiple sync tools sequentially and truncates large results", async () => {
		const { browser, calls } = browserClient();
		const tools = registry("({ args }) => args.value.repeat(5000)");
		const result = await executeActions({
			b: browser,
			actions: [
				{
					type: "custom_tool",
					name: "echo_value",
					arguments: { value: "x" },
				},
				{
					type: "custom_tool",
					name: "echo_value",
					arguments: { value: "y" },
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-custom-tool-test-memory",
			customTools: tools,
		});
		assert.lengthOf(calls, 0);
		assert.lengthOf(result.toolObservations, 2);
		assert.include(result.toolObservations[0], "truncated");
		assert.isBelow(result.toolObservations[0].length, 4_100);
	});

	it("surfaces CDP failures as interaction errors", async () => {
		const browser = {
			client: {
				send: async () => {
					throw new Error("CDP request failed");
				},
			},
		} as unknown as Browser;
		const result = await executeActions({
			b: browser,
			actions: [
				{
					type: "custom_tool",
					name: "echo_value",
					arguments: { value: "hello" },
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-custom-tool-test-memory",
			customTools: registry("async ({ cdp }) => cdp.send('Runtime.evaluate')"),
		});
		assert.deepEqual(result.interactionErrors, [
			"echo_value(): CDP request failed",
		]);
	});

	it("reports thrown and non-serializable results as interaction errors", async () => {
		for (const source of [
			"async () => { throw new Error('boom') }",
			"() => undefined",
			"() => { const value = {}; value.self = value; return value }",
		]) {
			const { browser } = browserClient();
			const result = await executeActions({
				b: browser,
				actions: [
					{
						type: "custom_tool",
						name: "echo_value",
						arguments: { value: "hello" },
					},
				],
				openTabs: [],
				memoryFile: "/tmp/browser-agent-custom-tool-test-memory",
				customTools: registry(source),
			});
			assert.lengthOf(result.interactionErrors, 1);
			assert.match(result.interactionErrors[0], /^echo_value\(\):/);
		}
	});

	it("exposes controlled memory capabilities and terminal return_results", async () => {
		const { browser } = browserClient();
		const files = memoryFiles();
		try {
			const result = await executeActions({
				b: browser,
				actions: [
					{
						type: "custom_tool",
						name: "echo_value",
						arguments: { value: "from custom tool" },
					},
					{
						type: "custom_tool",
						name: "echo_value",
						arguments: { value: "must not run" },
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.resultFile,
				customTools:
					registry(`async ({ args, memory_read, memory_write, memory_result_write, return_results }) => {
					memory_write(args.value);
					await memory_result_write([{ link: "custom:test", summary: args.value }]);
					const memory = await memory_read();
					if (!memory.memory.includes(args.value) || !memory.memory_result.includes(args.value)) throw new Error("memory unavailable");
					await return_results();
				}`),
			});
			assert.deepEqual(result.interactionErrors, []);
			assert.equal(
				fs.readFileSync(files.memoryFile, "utf-8"),
				"from custom tool",
			);
			assert.include(result.returnedResult, "custom:test");
			assert.notInclude(result.returnedResult, "must not run");
		} finally {
			fs.rmSync(files.directory, { recursive: true, force: true });
		}
	});

	it("does not inject filesystem or Node process globals", async () => {
		const { browser } = browserClient();
		const result = await executeActions({
			b: browser,
			actions: [
				{
					type: "custom_tool",
					name: "echo_value",
					arguments: { value: "hello" },
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-custom-tool-test-memory",
			customTools: registry(
				"() => ({ fs: typeof fs, process: typeof process, require: typeof require })",
			),
		});
		assert.include(
			result.toolObservations[0],
			'"fs":"undefined","process":"undefined","require":"undefined"',
		);
	});

	it("includes custom names and arguments in stagnation signatures", () => {
		const base = {
			thinking: "",
			done: false,
			actions: [
				{
					type: "custom_tool" as const,
					name: "echo_value",
					arguments: { value: "one" },
				},
			],
		};
		assert.notEqual(
			buildActionSignatureWithUrl(base, "https://example.test"),
			buildActionSignatureWithUrl(
				{
					...base,
					actions: [{ ...base.actions[0], arguments: { value: "two" } }],
				},
				"https://example.test",
			),
		);
	});
});
