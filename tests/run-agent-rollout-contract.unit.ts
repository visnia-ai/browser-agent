import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { createMockCoreDeps } from "./helpers/core-deps-fixtures.js";
import { runTrainingRollout } from "../src/core/training-rollout.js";
import { setRuntimeOptions } from "../src/runtime-options.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { OpenAIContinuationError } from "../src/agents/providers/router.js";

describe("runTrainingRollout", () => {
	beforeEach(() => {
		setRuntimeOptions({ saveStepsContext: false });
	});

	afterEach(() => {
		setRuntimeOptions({ saveStepsContext: true });
	});

	it("captures prompt, generation, and browse artifacts from the official harness", async () => {
		const deps = createMockCoreDeps({
			userActionBehavior: "return",
			executeActions: async ({ actions }) => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				...(actions.some((action) => action.type === "return_results")
					? { returnedResult: "Success" }
					: {}),
			}),
		});
		let callCount = 0;
		const continuationInputs: Array<{
			messageCount: number;
		}> = [];

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Finish the task",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: {
				...deps.featureFlags,
				semanticProjectionHistory: "cumulative",
			},
			userActionBehavior: "return",
			maxSteps: 2,
			generateStep: async ({
				messages,
				promptPayload,
				stepKind,
				providerContinuation,
			}) => {
				callCount += 1;
				assert.isDefined(providerContinuation);
				continuationInputs.push({
					messageCount: providerContinuation?.messages.length ?? 0,
				});
				assert.isArray(messages);
				assert.strictEqual(
					stepKind,
					callCount === 1 ? "executor_step" : "max_step_finalization",
				);
				assert.strictEqual(promptPayload.currentURL, "https://target.example");
				if (callCount === 1) {
					return {
						data: {
							thinking: "Click",
							actions: [{ type: "click", ref: "1" }],
							done: false,
						},
						usage: {
							input_tokens: 12,
							output_tokens: 4,
							total_tokens: 16,
						},
						reasoning_tokens: "reasoning",
						providerContinuation: {
							provider: "openai",
							strategy: "cumulative",
							messages: [
								{
									role: "assistant",
									content: [
										{
											type: "reasoning",
											text: "summary",
											providerOptions: {
												openai: {
													reasoningEncryptedContent: "test-encrypted-reasoning",
												},
											},
										},
									],
								},
							],
						},
						rawModelOutputText: "reasoning\n</think>\n\nthinking: Click",
						promptTokenIds: [1, 2, 3],
						completionTokenIds: [4, 5],
						studentLogprobs: [-0.1, -0.2],
						teacherPromptMessages: [{ role: "user", content: "teacher" }],
					};
				}
				return {
					data: {
						thinking: "Return results",
						actions: [{ type: "return_results" }],
						done: false,
					},
					usage: {
						input_tokens: 12,
						output_tokens: 4,
						total_tokens: 16,
					},
					reasoning_tokens: "reasoning",
					providerContinuation: {
						provider: "openai",
						strategy: "cumulative",
						messages: [
							{
								role: "assistant",
								content: "accepted-response-2",
							},
						],
					},
					rawModelOutputText: "reasoning\n</think>\n\nthinking: Done",
					promptTokenIds: [1, 2, 3],
					completionTokenIds: [4, 5],
					studentLogprobs: [-0.1, -0.2],
					teacherPromptMessages: [{ role: "user", content: "teacher" }],
				};
			},
		});

		assert.strictEqual(callCount, 2);
		assert.equal(continuationInputs[0]?.messageCount, 0);
		assert.equal(continuationInputs[1]?.messageCount, 1);
		assert.isTrue(result.run.completed);
		assert.isTrue(result.run.successful);
		assert.lengthOf(result.steps, 2);
		assert.deepEqual(result.steps[0].promptTokenIds, [1, 2, 3]);
		assert.deepEqual(result.steps[0].completionTokenIds, [4, 5]);
		assert.deepEqual(result.steps[0].studentLogprobs, [-0.1, -0.2]);
		assert.strictEqual(
			result.steps[0].rawModelOutputText,
			"reasoning\n</think>\n\nthinking: Click",
		);
		assert.strictEqual(
			result.steps[0].promptPayload.currentURL,
			"https://target.example",
		);
		assert.strictEqual(result.steps[0].normalizedStep.done, false);
		assert.isDefined(result.steps[0].browse);
		assert.strictEqual(result.steps[1].terminal?.successful, true);
		assert.notInclude(JSON.stringify(result), "test-encrypted-reasoning");
		for (const loopEntry of result.run.mainLoopEntries) {
			const assistantContent = String(loopEntry.messages.at(-1)?.content ?? "");
			assert.notInclude(assistantContent, "done:");
			assert.notInclude(assistantContent, "result:");
		}
	});

	it("preserves validator-backed unsuccessful terminal results from return_results", async () => {
		const deps = createMockCoreDeps({
			executeActions: async () => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				returnedResult: "Claimed success",
			}),
			verifyTaskSuccess: async () => ({
				success: false,
				summary: "Missing artifact",
				reasons: ["missing artifact"],
				model: "gpt-test",
				provider: "openai",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
				},
			}),
		});

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9333,
				headless: true,
				forceRestart: true,
			},
			task: "Report completion",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			maxSteps: 2,
			validatorLifecycle: { mode: "terminal", maxFailures: 3 },
			generateStep: async () => ({
				data: {
					thinking: "Return the result",
					actions: [{ type: "return_results" }],
					done: false,
				},
				usage: {
					input_tokens: 7,
					output_tokens: 2,
					total_tokens: 9,
				},
				reasoning_tokens: "",
				rawModelOutputText: "thinking: Return the result",
			}),
		});

		assert.isTrue(result.run.completed);
		assert.isFalse(result.run.successful);
		assert.strictEqual(result.steps[0].terminal?.completed, true);
		assert.strictEqual(result.steps[0].terminal?.successful, false);
		assert.strictEqual(
			result.steps[0].terminal?.successVerification?.summary,
			"Missing artifact",
		);
	});

	it("accepts completion without calling the validator when disabled", async () => {
		let verificationCalls = 0;
		const deps = createMockCoreDeps({
			executeActions: async () => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				returnedResult: "Unverified result",
			}),
			verifyTaskSuccess: async () => {
				verificationCalls += 1;
				throw new Error("validator should not run");
			},
		});

		const result = await runTrainingRollout(deps, {
			session: { port: 9334, headless: true, forceRestart: true },
			task: "Report completion",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			maxSteps: 2,
			validatorLifecycle: { mode: "disabled", maxFailures: 3 },
			generateStep: async () => ({
				data: {
					thinking: "Return the result",
					actions: [{ type: "return_results" }],
					done: false,
				},
				usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
				reasoning_tokens: "",
				rawModelOutputText: "thinking: Return the result",
			}),
		});

		assert.strictEqual(verificationCalls, 0);
		assert.isTrue(result.run.completed);
		assert.isTrue(result.run.successful);
		assert.isUndefined(result.run.successVerification);
	});

	it("uses default retry verification and accepts a corrected result", async () => {
		let resultCalls = 0;
		let verificationCalls = 0;
		let secondPromptPayload: Record<string, unknown> | undefined;
		const deps = createMockCoreDeps({
			executeActions: async () => {
				resultCalls += 1;
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
					returnedResult:
						resultCalls === 1 ? "Incomplete answer" : "Corrected answer",
				};
			},
			verifyTaskSuccess: async () => {
				verificationCalls += 1;
				return {
					success: verificationCalls > 1,
					summary:
						verificationCalls === 1
							? "A required field is missing."
							: "Task succeeded.",
					reasons:
						verificationCalls === 1
							? ["Include the missing required field."]
							: [],
					model: "gpt-test",
					provider: "openai",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
					},
				};
			},
		});

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9388,
				headless: true,
				forceRestart: true,
			},
			task: "Return every required field",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			maxSteps: 3,
			generateStep: async ({ stepNumber, promptPayload }) => {
				if (stepNumber === 2) secondPromptPayload = promptPayload;
				return {
					data: {
						thinking:
							stepNumber === 1
								? "Return initial result"
								: "Fix the rejected result",
						actions: [{ type: "return_results" }],
						done: false,
					},
					usage: {
						input_tokens: 7,
						output_tokens: 2,
						total_tokens: 9,
					},
					reasoning_tokens: "",
					rawModelOutputText: `step ${stepNumber}`,
				};
			},
		});

		assert.strictEqual(resultCalls, 2);
		assert.strictEqual(verificationCalls, 2);
		assert.isTrue(result.run.completed);
		assert.isTrue(result.run.successful);
		assert.strictEqual(result.run.result, "Corrected answer");
		assert.deepInclude(secondPromptPayload?.validatorFeedback, {
			failure: 1,
			maxFailures: 3,
			summary: "A required field is missing.",
			reasons: ["Include the missing required field."],
		});
		assert.deepInclude(result.run.stepsHistory[1]?.payload, {
			validatorFeedback: secondPromptPayload?.validatorFeedback,
		});
	});

	it("reopens cumulative checklist items and forwards the configured verifier context", async () => {
		const originalTaskChecklist = configFeatureFlags.taskChecklist;
		setConfigFeatureFlags({ taskChecklist: true });
		try {
			let verificationCalls = 0;
			const verificationInputs: Array<Record<string, unknown>> = [];
			let secondChecklist: unknown;
			const deps = createMockCoreDeps({
				featureFlags: {
					...createMockCoreDeps().featureFlags,
					taskChecklist: true,
				},
				createChecklist: async () => ({
					items: ["Return all matches.", "Include a date for each match."],
				}),
				executeActions: async () => ({
					pendingMemoryRead: false,
					interactionErrors: [],
					returnedResult: verificationCalls === 0 ? "Incomplete" : "Corrected",
				}),
				verifyTaskSuccess: async (input) => {
					verificationInputs.push(input as unknown as Record<string, unknown>);
					verificationCalls += 1;
					return {
						success: verificationCalls > 1,
						summary:
							verificationCalls === 1
								? "C2 incomplete: add the missing date."
								: "Task succeeded.",
						reasons: [],
						reopenChecklistItemIds:
							verificationCalls === 1 ? ["C2"] : undefined,
						addChecklistItems:
							verificationCalls === 1
								? ["Include a source link for every match."]
								: undefined,
						model: "gpt-test",
						provider: "openai",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
						},
					};
				},
			});

			const result = await runTrainingRollout(deps, {
				session: { port: 9389, headless: true, forceRestart: true },
				task: "Return all matches with dates and links",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					verifySuccess: { provider: "openai", model: "gpt-test" },
				},
				dataExtraction: { provider: "openai", model: "gpt-test" },
				featureFlags: deps.featureFlags,
				maxSteps: 3,
				validatorLifecycle: {
					mode: "retry",
					maxFailures: 3,
					context: "compact",
				},
				generateStep: async ({ stepNumber, promptPayload }) => {
					if (stepNumber === 2) secondChecklist = promptPayload.checklist;
					return {
						data: {
							checklistUpdate:
								stepNumber === 1
									? { C1: "done", C2: "done" }
									: { C2: "done", C3: "done" },
							actions: [{ type: "return_results" }],
							done: false,
						},
						usage: {
							input_tokens: 7,
							output_tokens: 2,
							total_tokens: 9,
						},
						reasoning_tokens: "",
						rawModelOutputText: `step ${stepNumber}`,
					};
				},
			});

			assert.isTrue(result.run.successful);
			assert.deepEqual(secondChecklist, [
				"[DONE] C1 Return all matches.",
				"[TODO] C2 Include a date for each match.",
				"[TODO] C3 Include a source link for every match.",
			]);
			assert.equal(verificationInputs[0].purpose, "completion_verifier");
			assert.equal(verificationInputs[0].contextMode, "compact");
		} finally {
			setConfigFeatureFlags({ taskChecklist: originalTaskChecklist });
		}
	});

	it("stops after the configured number of validator failures", async () => {
		let resultCalls = 0;
		let verificationCalls = 0;
		const deps = createMockCoreDeps({
			executeActions: async () => {
				resultCalls += 1;
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
					returnedResult: `Rejected answer ${resultCalls}`,
				};
			},
			verifyTaskSuccess: async () => {
				verificationCalls += 1;
				return {
					success: false,
					summary: `Rejected ${verificationCalls}`,
					reasons: ["Still incomplete."],
					model: "gpt-test",
					provider: "openai",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
					},
				};
			},
		});

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9399,
				headless: true,
				forceRestart: true,
			},
			task: "Return every required field",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			maxSteps: 5,
			validatorLifecycle: { mode: "retry", maxFailures: 3 },
			generateStep: async ({ stepNumber }) => ({
				data: {
					thinking: `Attempt ${stepNumber}`,
					actions: [{ type: "return_results" }],
					done: false,
				},
				usage: {
					input_tokens: 7,
					output_tokens: 2,
					total_tokens: 9,
				},
				reasoning_tokens: "",
				rawModelOutputText: `step ${stepNumber}`,
			}),
		});

		assert.strictEqual(resultCalls, 3);
		assert.strictEqual(verificationCalls, 3);
		assert.isTrue(result.run.completed);
		assert.isFalse(result.run.successful);
		assert.strictEqual(result.run.result, "Rejected answer 3");
		assert.lengthOf(result.run.stepsHistory, 3);
	});

	it("preserves user takeover as terminal metadata on the final step", async () => {
		const deps = createMockCoreDeps({
			userActionBehavior: "return",
			executeActions: async () => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				userTakeover: {
					reason: "Please log in",
					category: "authentication",
				},
			}),
		});

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9444,
				headless: true,
				forceRestart: true,
			},
			task: "Login required",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: deps.featureFlags,
			userActionBehavior: "return",
			maxSteps: 2,
			generateStep: async () => ({
				data: {
					thinking: "Need manual login",
					actions: [
						{
							type: "user_takeover",
							request: "Please log in",
							category: "authentication",
						},
					],
					done: false,
				},
				usage: {
					input_tokens: 4,
					output_tokens: 1,
					total_tokens: 5,
				},
				reasoning_tokens: "",
				rawModelOutputText: "thinking: takeover",
			}),
		});

		assert.isFalse(result.run.completed);
		assert.deepEqual(result.run.userActionRequired, {
			kind: "browser_user_takeover",
			reason: "Please log in",
			category: "authentication",
		});
		assert.deepEqual(result.steps[0].terminal?.userActionRequired, {
			kind: "browser_user_takeover",
			reason: "Please log in",
			category: "authentication",
		});
	});

	it("drops artifacts from failed step attempts before retry succeeds", async () => {
		let actionCalls = 0;
		const deps = createMockCoreDeps({
			executeActions: async () => {
				actionCalls += 1;
				if (actionCalls === 1) {
					throw new Error("transient browse failure");
				}
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
				};
			},
		});
		let generationCalls = 0;
		const replayedReasoning: string[][] = [];

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9555,
				headless: true,
				forceRestart: true,
			},
			task: "Retry after transient failure",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: {
				...deps.featureFlags,
				semanticProjectionHistory: "current",
			},
			maxSteps: 2,
			generateStep: async ({ stepNumber, providerContinuation }) => {
				generationCalls += 1;
				const replayState =
					providerContinuation?.strategy === "current"
						? providerContinuation.reasoningStateByStep
						: [];
				replayedReasoning.push(
					replayState.flatMap((state) =>
						state.messages.flatMap((message) =>
							Array.isArray(message.content)
								? message.content.flatMap((part) =>
										part.type === "reasoning" ? [part.text] : [],
									)
								: [],
						),
					),
				);
				return stepNumber === 1
					? {
							data: {
								thinking: "Click",
								actions: [{ type: "click", ref: "1" }],
								done: false,
							},
							usage: {
								input_tokens: 5,
								output_tokens: 1,
								total_tokens: 6,
							},
							reasoning_tokens: "",
							providerContinuation: {
								provider: "openai",
								strategy: "current",
								reasoningMessages: [
									{
										role: "assistant",
										content: [
											{
												type: "reasoning",
												text: `candidate-${generationCalls}`,
											},
										],
									},
								],
							},
							rawModelOutputText: `attempt ${generationCalls}`,
						}
					: {
							data: {
								thinking: "Done",
								actions: [],
								done: true,
								result: "Success",
							},
							usage: {
								input_tokens: 5,
								output_tokens: 1,
								total_tokens: 6,
							},
							reasoning_tokens: "",
							rawModelOutputText: "final",
						};
			},
		});

		assert.strictEqual(actionCalls, 2);
		assert.strictEqual(generationCalls, 3);
		assert.deepEqual(replayedReasoning, [[], [], ["candidate-2"]]);
		assert.lengthOf(result.steps, 2);
		assert.strictEqual(result.steps[0].rawModelOutputText, "attempt 2");
		assert.strictEqual(result.steps[1].rawModelOutputText, "final");
	});

	it("rejects malformed action lists atomically and repairs them within the existing retry loop", async () => {
		const executedActionTypes: string[][] = [];
		const deps = createMockCoreDeps({
			executeActions: async ({ actions }) => {
				executedActionTypes.push(actions.map((action) => action.type));
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
					...(actions.some((action) => action.type === "return_results")
						? { returnedResult: "Success" }
						: {}),
				};
			},
		});
		let generationCalls = 0;
		const modelOutputErrorsByAttempt: unknown[] = [];
		const replayedReasoningByAttempt: string[][] = [];
		const assistantMessagesByAttempt: string[][] = [];
		const acceptedRawAssistant = [
			"thinking: Keep this exact accepted response.",
			"tools:",
			"  - read_file: ./notes.txt",
			"done: false",
		].join("\n");
		const dispositions: Array<{
			attempt: number;
			disposition: "accepted" | "rejected";
		}> = [];

		const result = await runTrainingRollout(deps, {
			session: {
				port: 9666,
				headless: true,
				forceRestart: true,
			},
			task: "Repair a malformed action response",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: {
				...deps.featureFlags,
				semanticProjectionHistory: "current",
			},
			maxSteps: 2,
			onStepGenerated: ({ attempt, disposition }) => {
				dispositions.push({ attempt, disposition });
			},
			generateStep: async ({
				messages,
				promptPayload,
				providerContinuation,
			}) => {
				generationCalls += 1;
				assistantMessagesByAttempt.push(
					messages
						.filter((message) => message.role === "assistant")
						.map((message) => String(message.content)),
				);
				modelOutputErrorsByAttempt.push(promptPayload.modelOutputErrors);
				const replayState =
					providerContinuation?.strategy === "current"
						? providerContinuation.reasoningStateByStep
						: [];
				replayedReasoningByAttempt.push(
					replayState.flatMap((state) =>
						state.messages.flatMap((message) =>
							Array.isArray(message.content)
								? message.content.flatMap((part) =>
										part.type === "reasoning" ? [part.text] : [],
									)
								: [],
						),
					),
				);

				const common = {
					usage: {
						input_tokens: 10,
						output_tokens: 1,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
				if (generationCalls === 1) {
					return {
						...common,
						data: {
							previousStepPlanUpdate: [{ index: 0, status: "done" }],
							checklistUpdate: { C1: "done" },
							tools: [{ click: "r1" }, { type: { text: "missing ref" } }],
						} as any,
						providerContinuation: {
							provider: "openai" as const,
							strategy: "current" as const,
							reasoningMessages: [
								{
									role: "assistant" as const,
									content: [
										{
											type: "reasoning" as const,
											text: "rejected-reasoning",
										},
									],
								},
							],
						},
						rawModelOutputText: "malformed attempt",
					};
				}
				if (generationCalls === 2) {
					return {
						...common,
						data: {
							thinking: "Keep this exact accepted response.",
							tools: [{ read_file: "./notes.txt" }],
							done: false,
						} as any,
						providerContinuation: {
							provider: "openai" as const,
							strategy: "current" as const,
							reasoningMessages: [
								{
									role: "assistant" as const,
									content: [
										{
											type: "reasoning" as const,
											text: "accepted-reasoning",
										},
									],
								},
							],
						},
						rawModelOutputText: acceptedRawAssistant,
					};
				}
				return {
					...common,
					data: { tools: ["return_results"] } as any,
					rawModelOutputText: "final",
				};
			},
		});

		assert.strictEqual(generationCalls, 3);
		assert.deepEqual(dispositions, [
			{ attempt: 1, disposition: "rejected" },
			{ attempt: 2, disposition: "accepted" },
			{ attempt: 1, disposition: "accepted" },
		]);
		assert.isUndefined(modelOutputErrorsByAttempt[0]);
		assert.include(
			JSON.stringify(modelOutputErrorsByAttempt[1]),
			"entire action list was rejected",
		);
		assert.isUndefined(modelOutputErrorsByAttempt[2]);
		assert.deepEqual(replayedReasoningByAttempt, [
			[],
			[],
			["accepted-reasoning"],
		]);
		assert.deepEqual(executedActionTypes, [
			["read_file"],
			["return_results"],
		]);
		assert.deepEqual(assistantMessagesByAttempt.slice(0, 2), [[], []]);
		assert.lengthOf(assistantMessagesByAttempt[2], 1);
		assert.include(
			assistantMessagesByAttempt[2][0],
			"thinking: Keep this exact accepted response.",
		);
		assert.include(
			assistantMessagesByAttempt[2][0],
			"read_file: ./notes.txt",
		);
		assert.include(assistantMessagesByAttempt[2][0], "done: false");
		assert.notInclude(assistantMessagesByAttempt[2][0], "missing ref");
		assert.deepEqual(
			result.steps.map((entry) => entry.rawModelOutputText),
			[acceptedRawAssistant, "final"],
		);
		assert.lengthOf(result.run.mainLoopEntries, 2);
		const persistedAcceptedAssistant = String(
			result.run.mainLoopEntries[0]?.messages.at(-1)?.content,
		);
		assert.include(
			persistedAcceptedAssistant,
			"thinking: Keep this exact accepted response.",
		);
		assert.include(persistedAcceptedAssistant, "read_file: ./notes.txt");
		assert.notInclude(persistedAcceptedAssistant, "type: read_file");
		assert.deepInclude(result.run.stepTokenUsage[0], {
			input_tokens: 20,
			output_tokens: 2,
			total_tokens: 22,
		});
		assert.deepInclude(result.run.tokenTotals, {
			input_tokens: 30,
			output_tokens: 3,
			total_tokens: 33,
		});
	});

	it("uses stable cache keys partitioned by executor shard", async () => {
		const keys: string[] = [];
		const runOnce = async (port: number) => {
			const deps = createMockCoreDeps({
				executeActions: async () => ({
					pendingMemoryRead: false,
					interactionErrors: [],
					returnedResult: "Success",
				}),
			});
			return await runTrainingRollout(deps, {
				session: { port, headless: true, forceRestart: true },
				task: `Parallel trajectory ${port}`,
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-5.6-luna" },
					verifySuccess: { provider: "openai", model: "gpt-test" },
				},
				dataExtraction: { provider: "openai", model: "gpt-test" },
				featureFlags: deps.featureFlags,
				promptCacheShard: `worker-${port}`,
				maxSteps: 1,
				generateStep: async ({ openAIPromptCache }) => {
					keys.push(openAIPromptCache!.promptCacheKey);
					return {
						data: {
							thinking: "Done",
							actions: [{ type: "return_results" }],
							done: false,
						},
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
						},
						reasoning_tokens: "",
					};
				},
			});
		};

		await Promise.all([runOnce(9771), runOnce(9772)]);
		assert.lengthOf(keys, 2);
		assert.notEqual(keys[0], keys[1]);
	});

	it("replays only committed current-mode reasoning and drops the oldest item on overflow", async () => {
		const deps = createMockCoreDeps({
			executeActions: async ({ actions }) => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				...(actions.some((action) => action.type === "return_results")
					? { returnedResult: "Success" }
					: {}),
			}),
		});
		const replayCounts: number[] = [];
		let calls = 0;
		const encryptedReasoning = {
			role: "assistant" as const,
			content: [
				{
					type: "reasoning" as const,
					text: "opaque summary",
					providerOptions: {
						openai: {
							reasoningEncryptedContent: "current-secret-ciphertext",
						},
					},
				},
			],
		};

		const result = await runTrainingRollout(deps, {
			session: { port: 9773, headless: true, forceRestart: true },
			task: "Current replay overflow",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: {
				...deps.featureFlags,
				semanticProjectionHistory: "current",
			},
			maxSteps: 2,
			generateStep: async ({ stepNumber, providerContinuation }) => {
				calls += 1;
				assert.strictEqual(providerContinuation?.strategy, "current");
				const reasoningByStep =
					providerContinuation?.strategy === "current"
						? providerContinuation.reasoningStateByStep
						: [];
				replayCounts.push(reasoningByStep.length);
				if (reasoningByStep.length > 0) {
					assert.strictEqual(reasoningByStep[0]?.reasoningTokenCount, 4);
				}
				if (stepNumber === 2 && calls === 2) {
					throw new OpenAIContinuationError({
						reason: "context_length",
						usedContinuationState: true,
					});
				}
				const done = stepNumber === 2;
				return {
					data: {
						thinking: done ? "Done" : "Continue",
						actions: done
							? [{ type: "return_results" }]
							: [{ type: "wait", ms: 1 }],
						done: false,
					},
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						reasoning_tokens: 4,
					},
					reasoning_tokens: "visible diagnostic reasoning",
					providerContinuation: {
						provider: "openai",
						strategy: "current",
						reasoningMessages: done ? [] : [encryptedReasoning],
					},
				};
			},
		});

		assert.deepEqual(replayCounts, [0, 1, 0]);
		assert.isTrue(result.run.completed);
		assert.notInclude(JSON.stringify(result), "current-secret-ciphertext");
	});

	it("drops oldest current-mode reasoning until the estimated request fits", async () => {
		const deps = createMockCoreDeps({
			estimateTokenCount: () => 8,
			executeActions: async ({ actions }) => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				...(actions.some((action) => action.type === "return_results")
					? { returnedResult: "Success" }
					: {}),
			}),
		});
		const replayCounts: number[] = [];

		await runTrainingRollout(deps, {
			session: { port: 9774, headless: true, forceRestart: true },
			task: "Current replay budget",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: {
					provider: "openai",
					model: "gpt-test",
					maxModelLen: 10,
					reserveOutputTokens: 1,
				},
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: {
				...deps.featureFlags,
				semanticProjectionHistory: "current",
			},
			maxSteps: 2,
			generateStep: async ({ stepNumber, providerContinuation }) => {
				const replayState =
					providerContinuation?.strategy === "current"
						? providerContinuation.reasoningStateByStep
						: [];
				replayCounts.push(replayState.length);
				const done = stepNumber === 2;
				return {
					data: {
						thinking: done ? "Done" : "Continue",
						actions: done
							? [{ type: "return_results" }]
							: [{ type: "wait", ms: 1 }],
						done: false,
					},
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						reasoning_tokens: 4,
					},
					reasoning_tokens: "diagnostic reasoning",
					providerContinuation: {
						provider: "openai",
						strategy: "current",
						reasoningMessages: [
							{
								role: "assistant",
								content: [{ type: "reasoning", text: "opaque" }],
							},
						],
					},
				};
			},
		});

		assert.deepEqual(replayCounts, [0, 0]);
	});

	it("resets a continued chain once after an OpenAI context error", async () => {
		const deps = createMockCoreDeps({
			executeActions: async ({ actions }) => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				...(actions.some((action) => action.type === "return_results")
					? { returnedResult: "Success" }
					: {}),
			}),
		});
		let calls = 0;
		const modes: string[] = [];

		const result = await runTrainingRollout(deps, {
			session: { port: 9888, headless: true, forceRestart: true },
			task: "Recover from context exhaustion",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			dataExtraction: { provider: "openai", model: "gpt-test" },
			featureFlags: {
				...deps.featureFlags,
				semanticProjectionHistory: "cumulative",
			},
			maxSteps: 2,
			generateStep: async ({ stepNumber, providerContinuation }) => {
				calls += 1;
				modes.push(
					`${providerContinuation?.inputMode}:${providerContinuation?.messages.length ? "continued" : "fresh"}`,
				);
				if (calls === 2) {
					throw new OpenAIContinuationError({
						reason: "context_length",
						usedContinuationState: true,
					});
				}
				const done = stepNumber === 2;
				return {
					data: {
						thinking: done ? "Done" : "Continue",
						actions: done
							? [{ type: "return_results" }]
							: [{ type: "wait", ms: 1 }],
						done: false,
					},
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
					},
					reasoning_tokens: "",
					providerContinuation: {
						provider: "openai",
						strategy: "cumulative",
						messages: [{ role: "assistant", content: `response-${calls}` }],
					},
				};
			},
		});

		assert.isTrue(result.run.completed);
		assert.deepEqual(modes, [
			"full:fresh",
			"incremental:continued",
			"full:fresh",
		]);
	});
});
