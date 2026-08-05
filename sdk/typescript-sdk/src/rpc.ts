import {
	BrowserAgentError,
	redact,
	type BrowserAgentErrorCode,
} from "./errors.js";
import type { RpcMessage } from "./protocol.js";
import type * as API from "./types.js";

const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new BrowserAgentError(
			"PROTOCOL_ERROR",
			"CLI emitted invalid task-result parameters.",
		);
	return value as Record<string, unknown>;
};
function normalizeResult(value: unknown): API.BrowserAgentTaskResult {
	const input = object(value);
	if (
		typeof input.task_id !== "string" ||
		!["completed", "failed"].includes(String(input.status)) ||
		!Array.isArray(input.runs)
	)
		throw new BrowserAgentError(
			"PROTOCOL_ERROR",
			"CLI emitted invalid task-result parameters.",
		);
	const runs: API.BrowserAgentTaskRunResult[] = input.runs.map((value) => {
		const run = object(value);
		const validator = object(run.validator);
		if (
			typeof run.run_index !== "number" ||
			typeof run.completed !== "boolean" ||
			typeof validator.ran !== "boolean" ||
			typeof validator.success !== "boolean" ||
			typeof validator.summary !== "string"
		)
			throw new BrowserAgentError(
				"PROTOCOL_ERROR",
				"CLI emitted an invalid task run.",
			);
		return {
			runIndex: run.run_index,
			completed: run.completed,
			data: run.data ?? null,
			validator: {
				ran: validator.ran,
				success: validator.success,
				summary: validator.summary,
			},
		};
	});
	return {
		taskId: input.task_id,
		status: input.status as "completed" | "failed",
		runs,
		errors: Array.isArray(input.errors)
			? input.errors.filter(
					(item): item is string => typeof item === "string",
				)
			: [],
	};
}
const order = (taskId: string) => {
	const match = /^task-(\d+)$/.exec(taskId);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};
const category = (value: unknown): API.UserTakeoverCategory =>
	["authentication", "otp", "verification", "payment"].includes(String(value))
		? (value as API.UserTakeoverCategory)
		: "other";

export class RpcState {
	readonly #results = new Map<string, API.BrowserAgentTaskResult>();
	constructor(
		private readonly runId: string,
		private readonly secrets: string[],
		private readonly paths: string[],
	) {}
	get results(): API.BrowserAgentTaskResult[] {
		return [...this.#results.values()].sort(
			(left, right) => order(left.taskId) - order(right.taskId),
		);
	}
	handle(
		message: RpcMessage,
	): API.BrowserAgentEvent | "complete" | undefined {
		if (message.id === 1) return this.#accept(message);
		const params = objectOrEmpty(message.params);
		if (message.method === "browser-agent/status")
			return {
				type: "user_takeover",
				runId: this.runId,
				taskId: String(params.task_id ?? ""),
				reason: String(params.reason ?? ""),
				category: category(params.category),
			};
		if (message.method === "browser-agent/task_result") {
			const result = normalizeResult(message.params);
			result.errors = result.errors.map((error) =>
				redact(error, this.secrets, this.paths),
			);
			this.#results.set(result.taskId, result);
			return { type: "task_result", runId: this.runId, result };
		}
		if (message.method === "browser-agent/all_tasks_completed") return "complete";
		if (message.method === "browser-agent/error")
			throw new BrowserAgentError(
				"PROCESS_EXITED",
				redact(
					String(params.message ?? "browser-agent failed."),
					this.secrets,
					this.paths,
				),
			);
	}
	#accept(message: RpcMessage): API.BrowserAgentEvent {
		if (message.error) {
			const code = message.error.data?.code;
			const allowed: BrowserAgentErrorCode[] = [
				"CONFIG_INVALID",
				"CHROME_NOT_FOUND",
			];
			throw new BrowserAgentError(
				allowed.includes(code as BrowserAgentErrorCode)
					? (code as BrowserAgentErrorCode)
					: "PROTOCOL_ERROR",
				redact(
					String(message.error.message ?? "CLI rejected the run."),
					this.secrets,
					this.paths,
				),
			);
		}
		if ((message.result as { accepted?: unknown })?.accepted !== true)
			throw new BrowserAgentError(
				"PROTOCOL_ERROR",
				"CLI did not accept the run.",
			);
		return { type: "run_started", runId: this.runId };
	}
}
const objectOrEmpty = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
