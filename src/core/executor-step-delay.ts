import type { Action } from "../agents/types.js";

const AGENT_LOCAL_ACTION_TYPES = new Set<Action["type"]>([
	"extract_data",
	"memory_clear",
	"memory_read",
	"memory_write",
	"return_results",
	"wait",
]);

export const DEFAULT_EXECUTOR_STEP_DELAY_MS = 500;

export function canSkipExecutorStepDelay(actions: Action[]): boolean {
	return actions.every((action) => AGENT_LOCAL_ACTION_TYPES.has(action.type));
}

export function getExecutorStepDelayMs(
	actions: Action[],
	optimizationEnabled: boolean,
): number {
	return optimizationEnabled && canSkipExecutorStepDelay(actions)
		? 0
		: DEFAULT_EXECUTOR_STEP_DELAY_MS;
}
