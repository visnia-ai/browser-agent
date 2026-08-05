import yaml from "js-yaml";
import { logActionBoundary } from "../agents/executor-utils/action-boundary-logging.js";
import { normalizeActionListWithDiagnostics } from "../agents/executor-utils/action-normalization.js";
import { formatStepForPrompt } from "../agents/executor-utils/step-execution.js";
import type { PreviousStepStatus, StepResult } from "../agents/types.js";
import { featureFlags } from "../featureFlags.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePreviousStepStatus(value: unknown): PreviousStepStatus {
	switch (value) {
		case "none":
		case "progressed":
		case "no_change":
		case "blocked":
		case "opened_tab":
		case "switched_context":
		case "partial":
			return value;
		default:
			return "none";
	}
}

function normalizeShortText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

type NormalizedModelStep =
	| {
			actionContractStatus: "accepted";
			step: StepResult;
			normalizationDiagnostics: [];
	  }
	| {
			actionContractStatus: "rejected";
			normalizationDiagnostics: string[];
	  };

function normalizeModelStep(raw: unknown): NormalizedModelStep {
	if (!isRecord(raw)) {
		return {
			actionContractStatus: "rejected",
			normalizationDiagnostics: ["model_step: expected an object response"],
		};
	}

	const rawActionContext = isRecord(raw.actionContext)
		? raw.actionContext
		: null;
	const rawActions = Array.isArray(raw.tools) ? raw.tools : raw.actions;
	const normalizedActions = normalizeActionListWithDiagnostics(rawActions);
	if (normalizedActions.status === "rejected") {
		return {
			actionContractStatus: "rejected",
			normalizationDiagnostics: normalizedActions.diagnostics,
		};
	}
	const step: StepResult = {
		thinking: typeof raw.thinking === "string" ? raw.thinking : "",
		checklistUpdate:
			raw.checklistUpdate &&
			typeof raw.checklistUpdate === "object" &&
			!Array.isArray(raw.checklistUpdate)
				? (raw.checklistUpdate as StepResult["checklistUpdate"])
				: undefined,
		...(featureFlags.executorActionContextFields
			? {
					previousStepStatus: normalizePreviousStepStatus(
						raw.previousStepStatus ?? rawActionContext?.status,
					),
					previousStepOutcome: normalizeShortText(
						raw.previousStepOutcome ?? rawActionContext?.outcome,
					),
					currentStateObservation: normalizeShortText(
						raw.currentStateObservation ?? rawActionContext?.state,
					),
					nextActionRationale: normalizeShortText(
						raw.nextActionRationale ?? rawActionContext?.next,
					),
				}
			: {}),
		actions: normalizedActions.actions,
		done: typeof raw.done === "boolean" ? raw.done : false,
	};

	if (typeof raw.result === "string") {
		step.result = raw.result;
	} else if (
		Array.isArray(raw.result) ||
		(raw.result && typeof raw.result === "object")
	) {
		step.result = yaml.dump(raw.result).trim();
	}

	return {
		step,
		actionContractStatus: "accepted",
		normalizationDiagnostics: [],
	};
}

function toAssistantStep(step: StepResult): Record<string, unknown> {
	return formatStepForPrompt(step);
}

export type ProcessedModelStepOutput =
	| {
			actionContractStatus: "accepted";
			step: StepResult;
			assistant: Record<string, unknown>;
			normalizationDiagnostics: [];
	  }
	| {
			actionContractStatus: "rejected";
			normalizationDiagnostics: string[];
	  };

export class ModelStepActionContractError extends Error {
	readonly diagnostics: string[];

	constructor(diagnostics: string[]) {
		super(`Model action contract rejected: ${diagnostics.join("; ")}`);
		this.name = "ModelStepActionContractError";
		this.diagnostics = [...diagnostics];
	}
}

export function processModelStepOutput(
	rawStepOutput: unknown,
): ProcessedModelStepOutput {
	const normalized = normalizeModelStep(rawStepOutput);
	const rawTools = isRecord(rawStepOutput) ? rawStepOutput.tools : undefined;
	logActionBoundary("model_step_normalized", {
		action_contract_status: normalized.actionContractStatus,
		raw_tools: rawTools,
		normalized_actions:
			normalized.actionContractStatus === "accepted"
				? normalized.step.actions
				: undefined,
		normalization_diagnostics: normalized.normalizationDiagnostics,
	});
	if (normalized.actionContractStatus === "rejected") {
		console.warn(
			`[executor-action-normalization] ${JSON.stringify({
				raw_tools: rawTools,
				diagnostics: normalized.normalizationDiagnostics,
			})}`,
		);
		return normalized;
	}
	return {
		...normalized,
		assistant: toAssistantStep(normalized.step),
	};
}
