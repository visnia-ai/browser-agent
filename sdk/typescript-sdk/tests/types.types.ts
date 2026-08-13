import {
	BrowserAgent,
	BrowserAgentError,
	type BrowserAgentCredential,
	type BrowserAgentCustomTool,
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
	type ValidatorLifecycleMode,
	type UserTakeoverCategory,
} from "../src/index.js";

const options: BrowserAgentOptions = {
	provider: "openai",
	model: "gpt-5.4",
	downloadDirectory: ".",
	validatorLifecycle: "disabled",
	customTools: [
		{
			name: "page_title",
			description: "Read the page title.",
			arguments: { type: "object", properties: {} },
			javascript: "() => document.title",
		},
	],
};
const agent = new BrowserAgent(options);
const codex = new BrowserAgent({
	provider: "codex",
	model: "gpt-5.4",
	downloadDirectory: ".",
});
const run: BrowserAgentRun = agent.run({ task: "test" });
const code: BrowserAgentErrorCode = new BrowserAgentError("CANCELLED", "test")
	.code;
// @ts-expect-error Per-run timeouts are intentionally absent from the SDK.
agent.run({ task: "test" }, { timeoutMs: 1 });
// @ts-expect-error The dependency seam is intentionally absent from the public API.
new BrowserAgent(options, {});
void run;
void codex;
void code;
type PublicTypes = [
	BrowserAgentCredential,
	BrowserAgentCustomTool,
	BrowserAgentEvent,
	BrowserAgentLogEntry,
	BrowserAgentResult,
	BrowserAgentRunOptions,
	BrowserAgentTask,
	BrowserAgentTaskResult,
	BrowserAgentTaskRunResult,
	Provider,
	ReasoningEffort,
	ValidatorLifecycleMode,
	UserTakeoverCategory,
];
type _Keep = PublicTypes;
