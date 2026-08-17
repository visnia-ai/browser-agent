import type { ExecutorContextPolicy, LLMOptions } from "./types.js";

export const OPENAI_EXECUTOR_CONTEXT_POLICY: Readonly<ExecutorContextPolicy> =
	Object.freeze({
		executorActionContextFields: false,
	});

export const OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY: Readonly<ExecutorContextPolicy> =
	Object.freeze({
		executorActionContextFields: true,
	});

export const NON_OPENAI_EXECUTOR_CONTEXT_POLICY: Readonly<ExecutorContextPolicy> =
	Object.freeze({
		executorActionContextFields: true,
	});

/**
 * Classify the model independently of its transport. Direct Codex models share
 * the OpenAI executor policy, while OpenRouter model IDs use an owner/model
 * shape, so `openai/...` must follow the same policy even though the request
 * provider is `openrouter`.
 */
export function resolveExecutorContextPolicy(
	llmOptions: Pick<LLMOptions, "provider" | "model">,
	enableExecutorActionContextFieldsForOpenAI = false,
): Readonly<ExecutorContextPolicy> {
	const normalizedModel = llmOptions.model.trim().toLowerCase();
	const usesOpenAIExecutorContextPolicy =
		llmOptions.provider === "openai" ||
		llmOptions.provider === "codex" ||
		normalizedModel.startsWith("openai/");
	if (!usesOpenAIExecutorContextPolicy) return NON_OPENAI_EXECUTOR_CONTEXT_POLICY;
	return enableExecutorActionContextFieldsForOpenAI
		? OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY
		: OPENAI_EXECUTOR_CONTEXT_POLICY;
}
