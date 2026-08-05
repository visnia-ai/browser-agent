const ACTION_BOUNDARY_LOG_ENV = "BROWSER_AGENT_LOG_ACTION_BOUNDARIES";

function isEnabledValue(value: string | undefined): boolean {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isActionBoundaryLoggingEnabled(): boolean {
	return isEnabledValue(process.env[ACTION_BOUNDARY_LOG_ENV]);
}

export function logActionBoundary(
	event: string,
	fields: Record<string, unknown>,
): void {
	if (!isActionBoundaryLoggingEnabled()) return;
	console.log(
		`[executor-action-boundary] ${JSON.stringify({
			event,
			...fields,
		})}`,
	);
}

