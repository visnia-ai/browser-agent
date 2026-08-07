import { runAgent } from "./run-agent.js";
import type {
	CoreDeps,
	RunAgentGenerateStepInput,
	RunAgentInput,
	RunTrainingRolloutInput,
	RunTrainingRolloutResult,
	TrainingRolloutStep,
} from "./types.js";

interface PendingTrainingRolloutStep {
	stepNumber: number;
	stepKind: "executor_step" | "max_step_finalization";
	promptMessages: TrainingRolloutStep["promptMessages"];
	promptPayload: TrainingRolloutStep["promptPayload"];
	rawModelOutputText: string;
	generatedStep: TrainingRolloutStep["generatedStep"];
	reasoningTokens: string;
	tokenUsage: TrainingRolloutStep["tokenUsage"];
	promptTokenIds: number[];
	completionTokenIds: number[];
	studentLogprobs: number[];
	teacherPromptMessages?: unknown[];
	providerMetadata?: unknown;
}

function isCoreDeps(value: unknown): value is CoreDeps {
	if (!value || typeof value !== "object") {
		return false;
	}
	return (
		"registry" in value &&
		"launchBrowser" in value &&
		"featureFlags" in value
	);
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

export async function runTrainingRollout(
	input: RunTrainingRolloutInput,
): Promise<RunTrainingRolloutResult>;

export async function runTrainingRollout(
	deps: CoreDeps,
	input: RunTrainingRolloutInput,
): Promise<RunTrainingRolloutResult>;

export async function runTrainingRollout(
	depsOrInput: CoreDeps | RunTrainingRolloutInput,
	maybeInput?: RunTrainingRolloutInput,
): Promise<RunTrainingRolloutResult> {
	const rawInput = isCoreDeps(depsOrInput) ? maybeInput : depsOrInput;
	if (!rawInput) {
		throw new Error("runTrainingRollout input is required.");
	}

	const pendingArtifacts = new Map<number, PendingTrainingRolloutStep[]>();
	const finalizedSteps: TrainingRolloutStep[] = [];

	const capturePendingArtifact = (
		stepInput: RunAgentGenerateStepInput,
		result: Awaited<ReturnType<RunTrainingRolloutInput["generateStep"]>>,
	): void => {
		const pendingForStep = pendingArtifacts.get(stepInput.stepNumber) ?? [];
		pendingForStep.push({
			stepNumber: stepInput.stepNumber,
			stepKind: stepInput.stepKind ?? "executor_step",
			promptMessages: cloneValue(stepInput.messages),
			promptPayload: cloneValue(stepInput.promptPayload),
			rawModelOutputText: result.rawModelOutputText,
			generatedStep: cloneValue(result.data),
			reasoningTokens: result.reasoning_tokens,
			tokenUsage: cloneValue(result.usage),
			promptTokenIds: [...(result.promptTokenIds ?? [])],
			completionTokenIds: [...(result.completionTokenIds ?? [])],
			studentLogprobs: [...(result.studentLogprobs ?? [])],
			teacherPromptMessages: result.teacherPromptMessages
				? cloneValue(result.teacherPromptMessages)
				: undefined,
			providerMetadata:
				result.providerMetadata === undefined
					? undefined
					: cloneValue(result.providerMetadata),
		});
		pendingArtifacts.set(stepInput.stepNumber, pendingForStep);
	};

	const consumePendingArtifact = (
		stepNumber: number,
	): PendingTrainingRolloutStep => {
		const pendingForStep = pendingArtifacts.get(stepNumber);
		const artifact = pendingForStep?.pop();
		if (!artifact) {
			throw new Error(
				`Missing training rollout artifact for step ${stepNumber}.`,
			);
		}
		pendingArtifacts.delete(stepNumber);
		return artifact;
	};

	const input: RunAgentInput = {
		...rawInput,
		generateStep: async (stepInput) => {
			const result = await rawInput.generateStep(stepInput);
			capturePendingArtifact(stepInput, result);
			return {
				data: result.data,
				usage: result.usage,
				accepted_usage: result.accepted_usage,
				reasoning_tokens: result.reasoning_tokens,
				raw_response: result.rawModelOutputText,
				providerContinuation: result.providerContinuation,
			};
		},
		onStepCompleted: async (stepResult) => {
			const artifact = consumePendingArtifact(stepResult.stepNumber);
			finalizedSteps.push({
				...artifact,
				normalizedStep: cloneValue(stepResult.step),
				browse:
					stepResult.browse === undefined
						? undefined
						: cloneValue(stepResult.browse),
				promptContext:
					stepResult.promptContext === undefined
						? undefined
						: cloneValue(stepResult.promptContext),
			});
			await rawInput.onStepCompleted?.(stepResult);
		},
	};

	const run = isCoreDeps(depsOrInput)
		? await runAgent(depsOrInput, input)
		: await runAgent(input);

	if (
		finalizedSteps.length > 0 &&
		(run.completed || run.userActionRequired !== undefined)
	) {
		finalizedSteps[finalizedSteps.length - 1] = {
			...finalizedSteps[finalizedSteps.length - 1],
			terminal: {
				completed: run.completed,
				successful: run.successful,
				successVerification: run.successVerification,
				userActionRequired: run.userActionRequired,
			},
		};
	}

	return {
		run,
		steps: finalizedSteps,
	};
}
