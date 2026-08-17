import { assert } from "chai";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import { buildSuccessVerificationMessages } from "../src/agents/success-verifier.js";
import type { VerifyTaskSuccessInput } from "../src/agents/success-verifier.js";

function input(
	overrides: Partial<VerifyTaskSuccessInput> = {},
): VerifyTaskSuccessInput {
	return {
		task: "Return every item with its date and link.",
		executedSteps: 4,
		maxSteps: 20,
		finalStep: {
			thinking: "done",
			checklistUpdate: { C1: "done" },
			previousStepStatus: "progressed",
			previousStepOutcome: "Loaded results",
			currentStateObservation: "Two results",
			nextActionRationale: "Return them",
			actions: [{ type: "return_results" }],
			done: true,
			result: '- link: "https://example.com"\n  summary: "One item"',
		},
		finalPromptPayload: {
			currentURL: "https://example.com/results",
			html: "full final dom",
			interactionErrors: [],
		},
		checklist: [
			{ id: "C1", requirement: "Return every item.", status: "DONE" },
			{ id: "C2", requirement: "Include date and link.", status: "TODO" },
		],
		historyMessages: [
			{ role: "user", content: "prior stripped payload" },
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "prior reasoning",
						providerOptions: {
							google: { thoughtSignature: "verifier-signature" },
						},
					},
					{ type: "text", text: "prior action" },
				],
			},
		],
		llmOptions: {
			provider: "openai",
			model: "gpt-5.4",
			reasoningEffort: "low",
		},
		purpose: "completion_verifier",
		...overrides,
	};
}

function userPayload(
	result: ReturnType<typeof buildSuccessVerificationMessages>,
) {
	const content = result.messages.at(-1)?.content;
	assert.isString(content);
	return yaml.load(content as string) as Record<string, unknown>;
}

describe("success verifier context modes", () => {
	it("builds compact input from only task, checklist, and exact candidate result", () => {
		const result = buildSuccessVerificationMessages(
			input({ contextMode: "compact" }),
		);
		assert.deepEqual(Object.keys(userPayload(result)), [
			"task",
			"checklist",
			"candidateResult",
		]);
		assert.equal(userPayload(result).candidateResult, input().finalStep.result);
		assert.include(
			result.messages[0].content as string,
			"semantic correctness",
		);
	});

	it("preserves existing full metadata and adds the same checklist", () => {
		const result = buildSuccessVerificationMessages(
			input({ contextMode: "full" }),
		);
		const payload = userPayload(result);
		assert.deepEqual(payload.finalPromptPayload, input().finalPromptPayload);
		assert.notProperty(payload, "stepHistory");
		assert.deepEqual(result.messages.slice(1, -1), [
			{ role: "user", content: "prior stripped payload" },
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "prior reasoning",
						providerOptions: {
							google: { thoughtSignature: "verifier-signature" },
						},
					},
					{ type: "text", text: "prior action" },
				],
			},
		]);
		assert.deepEqual(payload.checklist, input().checklist);
		assert.deepEqual(payload.finalStep, {
			thinking: input().finalStep.thinking,
			checklistUpdate: input().finalStep.checklistUpdate,
			tools: input().finalStep.actions,
			done: input().finalStep.done,
			result: input().finalStep.result,
		});
	});

	it("builds a compact terminal-judge payload when requested", () => {
		const result = buildSuccessVerificationMessages(
			input({ purpose: "terminal_judge", contextMode: "compact" }),
		);
		const payload = userPayload(result);
		assert.notProperty(payload, "checklist");
		assert.deepEqual(Object.keys(payload), [
			"task",
			"executedSteps",
			"maxSteps",
			"finalStep",
		]);
		assert.deepEqual(payload.finalStep, {
			done: true,
			result: input().finalStep.result,
		});
		assert.include(
			result.messages[0].content as string,
			"Defer to the executor",
		);
	});
});
