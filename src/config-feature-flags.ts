export interface ConfigFeatureFlags {
	/** Attach a fresh full-page screenshot to the latest executor prompt before each step. */
	preStepScreenshotInLatestUserPrompt: boolean;
	/** Let the executor pause and request manual interaction from the user. */
	userTakeoverTool: boolean;
	/** Let the runtime attempt authentication with configured encrypted credentials. */
	authTakeover: boolean;
	/** Let the executor delegate bounded local or workspace file work to an agent. */
	agentTakeoverTool: boolean;
	/** Send the whole semantic projection to extract_data instead of selecting ref subtrees. */
	extractDataWholeContext: boolean;
	/** Choose current-only prompts (arm C) or append-only reset/delta history (arm D). */
	semanticProjectionHistory: "current" | "cumulative";
	/** Include executor action-context fields for OpenAI and Codex models. */
	enableExecutorActionContextFieldsForOpenAI: boolean;
	/** Skip the post-step settling delay when every action is agent-local. */
	optimizeExecutorStepDelays: boolean;
	/** Insert text in bulk for safe fields instead of typing one character at a time. */
	optimizeTextInput: boolean;
}

export const configFeatureFlags: ConfigFeatureFlags = {
	preStepScreenshotInLatestUserPrompt: true,
	userTakeoverTool: true,
	authTakeover: false,
	agentTakeoverTool: false,
	extractDataWholeContext: false,
	semanticProjectionHistory: "current",
	enableExecutorActionContextFieldsForOpenAI: false,
	optimizeExecutorStepDelays: false,
	optimizeTextInput: false,
};

export function mergeConfigFeatureFlags(
	base: ConfigFeatureFlags,
	overrides: Partial<ConfigFeatureFlags> = {},
): ConfigFeatureFlags {
	return {
		...base,
		...(overrides.preStepScreenshotInLatestUserPrompt !== undefined
			? {
					preStepScreenshotInLatestUserPrompt:
						overrides.preStepScreenshotInLatestUserPrompt,
				}
			: {}),
		...(overrides.userTakeoverTool !== undefined
			? { userTakeoverTool: overrides.userTakeoverTool }
			: {}),
		...(overrides.authTakeover !== undefined
			? { authTakeover: overrides.authTakeover }
			: {}),
		...(overrides.agentTakeoverTool !== undefined
			? { agentTakeoverTool: overrides.agentTakeoverTool }
			: {}),
		...(overrides.extractDataWholeContext !== undefined
			? { extractDataWholeContext: overrides.extractDataWholeContext }
			: {}),
		...(overrides.semanticProjectionHistory !== undefined
			? {
					semanticProjectionHistory: overrides.semanticProjectionHistory,
				}
			: {}),
		...(overrides.enableExecutorActionContextFieldsForOpenAI !== undefined
			? {
					enableExecutorActionContextFieldsForOpenAI:
						overrides.enableExecutorActionContextFieldsForOpenAI,
				}
			: {}),
		...(overrides.optimizeExecutorStepDelays !== undefined
			? {
					optimizeExecutorStepDelays: overrides.optimizeExecutorStepDelays,
				}
			: {}),
		...(overrides.optimizeTextInput !== undefined
			? { optimizeTextInput: overrides.optimizeTextInput }
			: {}),
	};
}

export function setConfigFeatureFlags(
	flags: Partial<ConfigFeatureFlags>,
): void {
	if (flags.preStepScreenshotInLatestUserPrompt !== undefined) {
		configFeatureFlags.preStepScreenshotInLatestUserPrompt =
			flags.preStepScreenshotInLatestUserPrompt;
	}
	if (flags.userTakeoverTool !== undefined) {
		configFeatureFlags.userTakeoverTool = flags.userTakeoverTool;
	}
	if (flags.authTakeover !== undefined) {
		configFeatureFlags.authTakeover = flags.authTakeover;
	}
	if (flags.agentTakeoverTool !== undefined) {
		configFeatureFlags.agentTakeoverTool = flags.agentTakeoverTool;
	}
	if (flags.extractDataWholeContext !== undefined) {
		configFeatureFlags.extractDataWholeContext = flags.extractDataWholeContext;
	}
	if (flags.semanticProjectionHistory !== undefined) {
		configFeatureFlags.semanticProjectionHistory =
			flags.semanticProjectionHistory;
	}
	if (flags.enableExecutorActionContextFieldsForOpenAI !== undefined) {
		configFeatureFlags.enableExecutorActionContextFieldsForOpenAI =
			flags.enableExecutorActionContextFieldsForOpenAI;
	}
	if (flags.optimizeExecutorStepDelays !== undefined) {
		configFeatureFlags.optimizeExecutorStepDelays =
			flags.optimizeExecutorStepDelays;
	}
	if (flags.optimizeTextInput !== undefined) {
		configFeatureFlags.optimizeTextInput = flags.optimizeTextInput;
	}
}

export function shouldUseCumulativeProjectionHistory(
	flags: ConfigFeatureFlags = configFeatureFlags,
): boolean {
	return flags.semanticProjectionHistory === "cumulative";
}
