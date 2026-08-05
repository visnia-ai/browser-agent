import {
	BrowserAgent,
	BrowserAgentError,
	type BrowserAgentCredential,
	type BrowserAgentErrorCode,
	type BrowserAgentEvent,
	type BrowserAgentLogEntry,
	type BrowserAgentOptions,
	type BrowserAgentResult,
	type BrowserAgentRun,
	type BrowserAgentRunOptions,
	type BrowserAgentTask,
	type BrowserAgentTaskResult,
	type BrowserAgentTaskRunResult,
	type Provider,
	type ReasoningEffort,
	type UserTakeoverCategory,
} from "../src/index.js";

const options: BrowserAgentOptions = {
	provider: "openai",
	model: "gpt-5.4",
	downloadDirectory: ".",
};
const agent = new BrowserAgent(options);
const run: BrowserAgentRun = agent.run({ task: "test" });
const code: BrowserAgentErrorCode = new BrowserAgentError("CANCELLED", "test")
	.code;
// @ts-expect-error Per-run timeouts are intentionally absent from the SDK.
agent.run({ task: "test" }, { timeoutMs: 1 });
// @ts-expect-error The dependency seam is intentionally absent from the public API.
new BrowserAgent(options, {});
void run;
void code;
type PublicTypes = [
	BrowserAgentCredential,
	BrowserAgentEvent,
	BrowserAgentLogEntry,
	BrowserAgentResult,
	BrowserAgentRunOptions,
	BrowserAgentTask,
	BrowserAgentTaskResult,
	BrowserAgentTaskRunResult,
	Provider,
	ReasoningEffort,
	UserTakeoverCategory,
];
type _Keep = PublicTypes;
