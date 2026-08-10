import type { BrowserAgentError } from "./errors.js";
export type Provider =
	| "openai"
	| "vllm"
	| "together"
	| "anthropic"
	| "google"
	| "codex"
	| "openrouter";
export type ReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max"
	| "enabled";
export interface BrowserAgentOptions {
	provider: Provider;
	model: string;
	reasoningEffort?: ReasoningEffort;
	apiKey?: string;
	endpointUrl?: string;
	openrouterProvider?: string;
	maxModelLen?: number;
	reserveOutputTokens?: number;
	headless?: boolean;
	executablePath?: string;
	downloadDirectory: string;
	workspaceDirectory?: string;
	browserProfileDirectory?: string;
	userTakeoverTool?: boolean;
	maxSteps?: number;
	concurrency?: number;
	runsPerTask?: number;
	retryCount?: number;
	onLog?: (entry: BrowserAgentLogEntry) => void;
}
export type BrowserAgentCredential = {
	username: string;
	password: string;
	domain: string;
};
export type BrowserAgentTask = {
	task: string;
	url?: string;
	credentials?: readonly BrowserAgentCredential[];
};
export type BrowserAgentRunOptions = {
	onEvent?: (event: BrowserAgentEvent) => void;
};
export type BrowserAgentLogEntry = {
	runId: string;
	message: string;
	timestamp: Date;
	source: "stderr";
};
export type UserTakeoverCategory =
	| "authentication"
	| "otp"
	| "verification"
	| "payment"
	| "other";
export type BrowserAgentTaskRunResult = {
	runIndex: number;
	completed: boolean;
	data: unknown;
	validator: { ran: boolean; success: boolean; summary: string };
};
export type BrowserAgentTaskResult = {
	taskId: string;
	status: "completed" | "failed";
	runs: BrowserAgentTaskRunResult[];
	errors: string[];
};
export type BrowserAgentResult = {
	runId: string;
	status: "completed" | "failed" | "cancelled";
	tasks: BrowserAgentTaskResult[];
	startedAt: Date;
	finishedAt: Date;
};
export type BrowserAgentEvent =
	| { type: "run_started"; runId: string }
	| {
			type: "user_takeover";
			runId: string;
			taskId: string;
			reason: string;
			category: UserTakeoverCategory;
	  }
	| {
			type: "task_result";
			runId: string;
			result: BrowserAgentTaskResult;
	  }
	| {
			type: "run_completed";
			runId: string;
			result: BrowserAgentResult;
	  }
	| { type: "error"; runId: string; error: BrowserAgentError };
export type BrowserAgentRun = {
	readonly id: string;
	readonly result: Promise<BrowserAgentResult>;
	events(): AsyncIterable<BrowserAgentEvent>;
	cancel(): Promise<void>;
};
