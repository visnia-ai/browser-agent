export const TIMING_LOG_MIN_DURATION_MS = 500;

export function shouldLogTimingDuration(
	durationMs: number,
	status: "ok" | "error" = "ok",
): boolean {
	return status === "error" || durationMs >= TIMING_LOG_MIN_DURATION_MS;
}
