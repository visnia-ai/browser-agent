export const featureFlags = {
	// Caps reasoning tokens for reasoning-enabled vLLM requests.
	maxThinkingTokenBudget: 2048,
	// Stops YAML generations after a closing marker in final-output text.
	yamlOutputStopSequences: [],
	// Adds structured previous-step action context to executor outputs and history.
	executorActionContextFields: true,
	// Requires a top-level executor thinking field for any model reasoning.
	executorThinkingField: false,
	// Carries provider reasoning into subsequent executor assistant messages.
	includeReasoningTokensInPreviousSteps: false,
};
