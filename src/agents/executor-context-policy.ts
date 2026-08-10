import type { ExecutorContextPolicy, LLMOptions } from "./types.js";

export const OPENAI_EXECUTOR_CONTEXT_POLICY: Readonly<ExecutorContextPolicy> =
	Object.freeze({
		includeReasoningTokensInPreviousSteps: true,
		executorActionContextFields: false,
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
): Readonly<ExecutorContextPolicy> {
	const normalizedModel = llmOptions.model.trim().toLowerCase();
	return llmOptions.provider === "openai" || normalizedModel.startsWith("openai/")
		? OPENAI_EXECUTOR_CONTEXT_POLICY
		: NON_OPENAI_EXECUTOR_CONTEXT_POLICY;
}
