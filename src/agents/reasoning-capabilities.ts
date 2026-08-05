import {
	OPENROUTER_REASONING_EFFORTS,
	REASONING_MODEL_CAPABILITIES,
	type Provider,
	type ReasoningEffort,
	type ReasoningModelCapability,
} from "../llm-capabilities.js";
import type { LLMOptions } from "./types.js";

export {
	REASONING_MODEL_CAPABILITIES,
	type ReasoningModelCapability,
} from "../llm-capabilities.js";

const VALIDATED_PROVIDERS = new Set<Provider>(["openai", "together", "vllm"]);

function matchesModel(
	capability: ReasoningModelCapability,
	model: string,
): boolean {
	if (capability.match === "exact") {
		return capability.model === model;
	}
	return model.toLowerCase().includes(capability.model);
}

export function getReasoningModelCapability(
	provider: Provider,
	model: string,
): ReasoningModelCapability | undefined {
	return REASONING_MODEL_CAPABILITIES.find(
		(capability) =>
			capability.provider === provider && matchesModel(capability, model),
	);
}

export function validateReasoningConfiguration(
	options: Pick<LLMOptions, "provider" | "model"> & {
		reasoningEffort?: ReasoningEffort;
	},
): void {
	if (options.provider === "openrouter") {
		if (options.reasoningEffort === undefined) {
			throw new Error(
				`Missing reasoning_effort for provider 'openrouter' model '${options.model}'. Allowed values: ${OPENROUTER_REASONING_EFFORTS.join(", ")}.`,
			);
		}
		const allowedEfforts: readonly ReasoningEffort[] =
			OPENROUTER_REASONING_EFFORTS;
		if (!allowedEfforts.includes(options.reasoningEffort)) {
			throw new Error(
				`Unsupported reasoning_effort '${options.reasoningEffort}' for provider 'openrouter' model '${options.model}'. Allowed values: ${OPENROUTER_REASONING_EFFORTS.join(", ")}.`,
			);
		}
		return;
	}

	if (!VALIDATED_PROVIDERS.has(options.provider)) {
		return;
	}

	const capability = getReasoningModelCapability(
		options.provider,
		options.model,
	);
	if (!capability) {
		const knownModels = REASONING_MODEL_CAPABILITIES.filter(
			(entry) => entry.provider === options.provider,
		)
			.map((entry) =>
				entry.match === "exact" ? entry.model : `${entry.model} family`,
			)
			.join(", ");
		throw new Error(
			`Unknown reasoning model '${options.model}' for provider '${options.provider}'. Registered models: ${knownModels}.`,
		);
	}

	if (options.reasoningEffort === undefined) {
		throw new Error(
			`Missing reasoning_effort for provider '${options.provider}' model '${options.model}'. Allowed values: ${capability.reasoningEfforts.join(", ")}.`,
		);
	}

	const allowedEfforts: readonly ReasoningEffort[] =
		capability.reasoningEfforts;
	if (!allowedEfforts.includes(options.reasoningEffort)) {
		throw new Error(
			`Unsupported reasoning_effort '${options.reasoningEffort}' for provider '${options.provider}' model '${options.model}'. Allowed values: ${allowedEfforts.join(", ")}.`,
		);
	}
}
