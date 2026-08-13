import { assert } from "chai";
import { compileCustomTools } from "../src/custom-tools.js";
import { getExecutorSystem } from "../src/agents/prompts.js";
import { normalizeActionListWithDiagnostics } from "../src/agents/executor-utils/action-normalization.js";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import type { Browser } from "../src/browser/types.js";
import { buildActionSignatureWithUrl } from "../src/core/run-agent-loop-state.js";

function registry(javascript = "async (args) => ({ echoed: args.value })") {
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

function browserEvaluator() {
	const calls: Array<Record<string, unknown>> = [];
	const browser = {
		Runtime: {
			evaluate: async (request: Record<string, unknown>) => {
				calls.push(request);
				try {
					const value = await (0, eval)(String(request.expression));
					return { result: { type: "string", value } };
				} catch (error) {
					return {
						result: { type: "undefined" },
						exceptionDetails: {
							text: "Uncaught",
							exception: {
								description:
									error instanceof Error ? error.message : String(error),
							},
						},
					};
				}
			},
		},
	} as unknown as Browser;
	return { browser, calls };
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
		const prompt = getExecutorSystem({ customTools: registry("() => 'SECRET_SOURCE'") });
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

	it("executes async page functions and returns bounded observations", async () => {
		const { browser, calls } = browserEvaluator();
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
			customTools: registry(),
		});
		assert.deepEqual(result.interactionErrors, []);
		assert.include(result.toolObservations[0], '"echoed":"hello"');
		assert.equal(calls[0].timeout, 30_000);
	});

	it("executes multiple sync tools sequentially and truncates large results", async () => {
		const { browser, calls } = browserEvaluator();
		const tools = registry("(args) => args.value.repeat(5000)");
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
		assert.lengthOf(calls, 2);
		assert.lengthOf(result.toolObservations, 2);
		assert.include(result.toolObservations[0], "truncated");
		assert.isBelow(result.toolObservations[0].length, 4_100);
	});

	it("surfaces CDP timeouts as interaction errors", async () => {
		const browser = {
			Runtime: {
				evaluate: async () => {
					throw new Error("Timed out after 30000ms");
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
			customTools: registry(),
		});
		assert.deepEqual(result.interactionErrors, [
			"echo_value(): Timed out after 30000ms",
		]);
	});

	it("reports thrown and non-serializable results as interaction errors", async () => {
		for (const source of [
			"async () => { throw new Error('boom') }",
			"() => undefined",
			"() => { const value = {}; value.self = value; return value }",
		]) {
			const { browser } = browserEvaluator();
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
