export const featureFlags = {
	// Optional cap for reasoning-enabled vLLM requests. Omitted by default.
	maxThinkingTokenBudget: undefined as number | undefined,
	// Optional final-output text stops. Disabled by default.
	yamlOutputStopSequences: [] as string[],
	// Requires a top-level executor thinking field for any model reasoning.
	executorThinkingField: false,
};
