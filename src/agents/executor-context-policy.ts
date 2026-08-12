import type { ExecutorContextPolicy, LLMOptions } from "./types.js";

export const OPENAI_EXECUTOR_CONTEXT_POLICY: Readonly<ExecutorContextPolicy> =
	Object.freeze({
		includeReasoningTokensInPreviousSteps: true,
		executorActionContextFields: false,
	});

export const OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY: Readonly<ExecutorContextPolicy> =
	Object.freeze({
		includeReasoningTokensInPreviousSteps: true,
		executorActionContextFields: true,
	});

export const NON_OPENAI_EXECUTOR_CONTEXT_POLICY: Readonly<ExecutorContextPolicy> =
	Object.freeze({
		includeReasoningTokensInPreviousSteps: false,
		executorActionContextFields: true,
	});

/**
 * Classify the model independently of its transport. OpenRouter model IDs use
 * an owner/model shape, so `openai/...` must follow the OpenAI policy even
 * though the request provider is `openrouter`.
 */
export function resolveExecutorContextPolicy(
	llmOptions: Pick<LLMOptions, "provider" | "model">,
	enableExecutorActionContextFieldsForOpenAI = false,
): Readonly<ExecutorContextPolicy> {
	const normalizedModel = llmOptions.model.trim().toLowerCase();
	const isOpenAIModel =
		llmOptions.provider === "openai" || normalizedModel.startsWith("openai/");
	if (!isOpenAIModel) return NON_OPENAI_EXECUTOR_CONTEXT_POLICY;
	return enableExecutorActionContextFieldsForOpenAI
		? OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY
		: OPENAI_EXECUTOR_CONTEXT_POLICY;
}
