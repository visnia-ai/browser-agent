export const featureFlags = {
	// Optional cap for reasoning-enabled vLLM requests. Omitted by default.
	maxThinkingTokenBudget: undefined as number | undefined,
	// Optional final-output text stops. Disabled by default.
	yamlOutputStopSequences: [] as string[],
	// Adds structured previous-step action context to executor outputs and history.
	executorActionContextFields: false,
	// Requires a top-level executor thinking field for any model reasoning.
	executorThinkingField: false,
	// Carries provider reasoning into subsequent executor assistant messages for every provider.
	includeReasoningTokensInPreviousSteps: true,
};
