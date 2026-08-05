import { assert } from "chai";
import { describe, it } from "mocha";
import { buildStageModelInvocationTrace } from "../src/agents/model-invocation-tracing.js";

describe("buildStageModelInvocationTrace", () => {
	it("serializes a stage trace into disk-friendly format", () => {
		const trace = buildStageModelInvocationTrace({
			stage: "createChecklist",
			trace: {
				caller: "createChecklist",
				provider: "openai",
				model: "gpt-test",
				attempt: 2,
				messages: [
					{ role: "system", content: "Create a checklist." },
					{ role: "user", content: "Task: test" },
				],
				output: { steps: ["one", "two"] },
				raw_response: 'steps:\n  - "one"\n  - "two"',
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					total_tokens: 15,
				},
				reasoning_tokens: "brief rationale",
			},
			meta: {
				phase: "initial_checklist",
			},
		});

		assert.deepEqual(trace, {
			step_kind: "stage_llm",
			stage: "createChecklist",
			attempt: 2,
			caller: "createChecklist",
			provider: "openai",
			model: "gpt-test",
			messages: [
				{
					role: "system",
					content: "Create a checklist.",
					reasoning_tokens: "",
				},
				{
					role: "user",
					content: "Task: test",
					reasoning_tokens: "",
				},
			],
			output: { steps: ["one", "two"] },
			raw_response: 'steps:\n  - "one"\n  - "two"',
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				total_tokens: 15,
			},
			reasoning_tokens: "brief rationale",
			error: undefined,
			meta: {
				phase: "initial_checklist",
			},
		});
	});
});
