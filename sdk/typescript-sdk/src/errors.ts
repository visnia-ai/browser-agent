export type BrowserAgentErrorCode =
	| "CLI_NOT_FOUND"
	| "CLI_VERSION_INCOMPATIBLE"
	| "CHROME_NOT_FOUND"
	| "CONFIG_INVALID"
	| "PROCESS_START_FAILED"
	| "PROCESS_EXITED"
	| "PROTOCOL_ERROR"
	| "CANCELLED";

export class BrowserAgentError extends Error {
	constructor(
		readonly code: BrowserAgentErrorCode,
		message: string,
		options?: { details?: Record<string, unknown>; cause?: unknown },
	) {
		super(message);
		this.name = "BrowserAgentError";
		this.details = options?.details;
		this.cause = options?.cause;
	}
	readonly details?: Record<string, unknown>;
	readonly cause?: unknown;
}

export function redact(
	value: string,
	secrets: readonly string[],
	paths: readonly string[],
): string {
	let result = value;
	for (const secret of secrets)
		if (secret) result = result.replaceAll(secret, "<redacted>");
	for (const path of paths)
		if (path) result = result.replaceAll(path, "<internal>");
	return result;
}

export function asBrowserAgentError(
	error: unknown,
	code: BrowserAgentErrorCode,
	secrets: readonly string[],
	paths: readonly string[],
): BrowserAgentError {
	if (error instanceof BrowserAgentError) return error;
	const known = error instanceof Error;
	const message = redact(
		known ? error.message : String(error),
		secrets,
		paths,
	);
	return new BrowserAgentError(code, message, {
		cause: known ? new Error(message) : undefined,
	});
}
