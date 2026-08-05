import { assert } from "chai";
import { describe, it } from "mocha";
import { waitForUserTakeoverSignal } from "../src/agents/executor-utils/user-takeover.js";

describe("user-takeover", () => {
	it('waits until the user provides the "resume" signal', async () => {
		const questions: string[] = [];
		const logs: string[] = [];
		const answers = ["not-yet", "resume"];
		let answerIndex = 0;

		await waitForUserTakeoverSignal({
			reason: "Sign in flow requires manual password entry.",
			readSignal: async (question) => {
				questions.push(question);
				return answers[answerIndex++] || "resume";
			},
			log: (line) => logs.push(line),
		});

		assert.strictEqual(questions.length, 2);
		assert.include(
			questions[0],
			'Type "resume" to resume automation:',
		);
		assert.isTrue(
			logs.some((line) =>
				line.includes(
					"Reason: Sign in flow requires manual password entry.",
				),
			),
		);
		assert.isTrue(
			logs.some((line) => line.includes('Received "not-yet"')),
		);
		assert.isTrue(
			logs.some((line) =>
				line.includes('Resuming automation after user signal "resume"'),
			),
		);
	});

	it("supports a custom resume signal", async () => {
		const questions: string[] = [];
		let attempts = 0;

		await waitForUserTakeoverSignal({
			reason: "Payment form must be completed manually.",
			resumeSignal: "continue",
			readSignal: async (question) => {
				questions.push(question);
				attempts += 1;
				return attempts === 1 ? "CONTINUE" : "continue";
			},
			log: () => {},
		});

		assert.strictEqual(questions.length, 1);
		assert.include(questions[0], 'Type "continue" to resume automation:');
	});

	it('resumes from the in-page "Resume Agent" overlay button', async () => {
		const logs: string[] = [];
		const expressions: string[] = [];
		let browserSignalChecks = 0;

		const browser = {
			Runtime: {
				evaluate: async ({ expression }: { expression: string }) => {
					expressions.push(expression);
					if (expression.includes("window[\"__browserAgentResumeRequested\"] ?? null")) {
						browserSignalChecks += 1;
						return {
							result: {
								value:
									browserSignalChecks >= 2 ? "resume" : null,
							},
						};
					}
					return {
						result: {
							value: true,
						},
					};
				},
			},
		} as never;

		await waitForUserTakeoverSignal({
			reason: "Enter the OTP code.",
			browser,
			pollIntervalMs: 0,
			log: (line) => logs.push(line),
		});

		assert.isTrue(
			expressions.some((expression) =>
				expression.includes("User takeover required"),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes("Resume Agent"),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes('padding = "16px 18px 16px 22px"'),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes('background = "rgba(17, 24, 39, 0.72)"'),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes('backdropFilter = "blur(18px)"'),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes("pointerdown"),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes('cursor = "grab"'),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes("data-ba-irrelevant-pruned"),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes("data-ba-user-takeover-pruned-style"),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes("opacity: 1 !important; visibility: visible !important;"),
			),
		);
		assert.isTrue(
			expressions.some((expression) =>
				expression.includes("__browserAgentResumeRequested"),
			),
		);
		assert.isTrue(
			logs.some((line) => line.includes('Click "Resume Agent"')),
		);
		assert.isTrue(
			logs.some((line) =>
				line.includes('Resuming automation after in-browser "Resume Agent" click.'),
			),
		);
	});

	it("rejects empty takeover reason", async () => {
		let errorMessage = "";
		try {
			await waitForUserTakeoverSignal({
				reason: "   ",
				readSignal: async () => "resume",
				log: () => {},
			});
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
		assert.include(errorMessage, 'requires a non-empty "reason" string');
	});

	it("rejects non-sensitive takeover reasons", async () => {
		let errorMessage = "";
		try {
			await waitForUserTakeoverSignal({
				reason: "Please review page visuals.",
				readSignal: async () => "resume",
				log: () => {},
			});
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
		assert.include(errorMessage, "must describe a sensitive interaction");
	});
});
