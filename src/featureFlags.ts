export const featureFlags = {
	// Adds structured previous-step action context to executor outputs and history.
	executorActionContextFields: false,
	// Requires a top-level executor thinking field for any model reasoning.
	executorThinkingField: false,
	// Carries provider reasoning into subsequent executor assistant messages.
	includeReasoningTokensInPreviousSteps: true,
};
