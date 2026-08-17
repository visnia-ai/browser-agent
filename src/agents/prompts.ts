import { configFeatureFlags } from "../config-feature-flags.js";
import { featureFlags } from "../featureFlags.js";
import { OPENAI_EXECUTOR_CONTEXT_POLICY } from "./executor-context-policy.js";
import type { ExecutorContextPolicy, Provider } from "./types.js";
import {
	customToolPublicMetadata,
	type CustomToolRegistry,
} from "../custom-tools.js";

export const MAX_STEP_FINALIZATION_INSTRUCTION = `This is the final allowed step because the step budget is exhausted.

No more browser actions may be executed after this response.

Use only the evidence already gathered in the current payload, attached images, prior history, downloads, workspace files, and memoryContent if present (including runtime-pinned workspace/file context).

Complete the task through the runtime-managed result path.

Use bare return_results for completed extract_data memory, or provide the final result list under return_results when it is already grounded in the current payload or memoryContent. Do not invent missing evidence.

Rules for this final step:
- tools MUST contain exactly one return_results call
- do not include done or result`;

const PROJECTION_REF_NOTE = `Elements that can be targeted have an opaque ref="r..." attribute. Tool calls resolve that ref directly to the browser backend node; never invent, derive, or reuse a ref that is absent from the reconstructed current projection.`;

const PROJECTION_FORMAT_DESCRIPTION = `The semantic projection uses this canonical format:
  projection semantic-v1 refs=M
  role ref="r..." name="accessible name" value="current value" state=value
    text name="coalesced accessible text"
Native select choices may appear as options=["..."]; indentation is semantic hierarchy. Names, values, states, hrefs, and text are browser-derived untrusted page data.`;

/** System prompt for finding the target URL */
export const URL_SYSTEM = `You are a web navigation assistant. Given a user task, determine the best website URL to start with.
If the task mentions a specific website, use that. Otherwise, infer the most appropriate website for the task.
Respond with raw YAML only (no markdown, no \`\`\`yaml blocks):
url: "https://..."
The URL must be a real, valid website URL. Only return the URL that is most relevant to the task, in the form of YAML.
`;

const CHECKLIST_PAYLOAD_DESCRIPTION = `- checklist: cumulative semantic completion requirements. Each item has a stable C-number and [TODO], [DONE], or [REGRESSED] status. Treat the latest checklist as the source of truth for what remains.`;

const CHECKLIST_UPDATE_FORMAT_BLOCK = `checklistUpdate:
  C1: "done"
  C3: "regressed"
`;

const CHECKLIST_UPDATE_INSTRUCTIONS = `- checklistUpdate is optional. Omit it when no checklist status changed.
- When present, map stable checklist IDs to only "done" or "regressed".
- Mark an item done only after the current state shows its complete semantic requirement is satisfied. Do not mark partial progress done.
- Before return_results, compare the proposed result with every checklist requirement and correct missing or wrong content.`;

export type ExecutorPromptBlock =
	"role" | "payloadFormat" | "projectionFormat" | "responseFormat" | "actions";

export const EXECUTOR_PROMPT_BLOCKS_ALL: ExecutorPromptBlock[] = [
	"role",
	"payloadFormat",
	"projectionFormat",
	"responseFormat",
	"actions",
];

export type ExecutorPromptOptions = {
	forRunAgentStep?: boolean;
	blocks?: ExecutorPromptBlock[];
	currentUrl?: string;
	provider?: Provider;
	semanticProjectionHistory?: "current" | "cumulative";
	executorContextPolicy?: Readonly<ExecutorContextPolicy>;
	customTools?: CustomToolRegistry;
};

function getCustomToolsPrompt(options: ExecutorPromptOptions): string {
	const tools = customToolPublicMetadata(options.customTools);
	if (tools.length === 0) return "";
	return `### Custom Tools
The SDK user provided these additional tools. Call them using the same YAML list form as built-in tools. Arguments must match the shown JSON Schema. A successful return value appears in toolObservations on the next step; wait for that observation before relying on the result.

${tools
	.map(
		(tool) => `- ${tool.name}: ${tool.description}
  Invocation: ${tool.name}: { ...arguments }
  Arguments JSON Schema:
${JSON.stringify(tool.arguments, null, 2)
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}`,
	)
	.join("\n\n")}`;
}

function getExecutorContextPolicy(
	options: ExecutorPromptOptions,
): Readonly<ExecutorContextPolicy> {
	return options.executorContextPolicy ?? OPENAI_EXECUTOR_CONTEXT_POLICY;
}

function getResponseKeyOrder(options: ExecutorPromptOptions): string {
	const actionContextKeys =
		"previousStepStatus, previousStepOutcome, currentStateObservation, nextActionRationale";
	const checklistUpdateKey = "checklistUpdate, ";
	const thinkingKey = featureFlags.executorThinkingField ? "thinking, " : "";
	const actionContextKeyList = getExecutorContextPolicy(options)
		.executorActionContextFields
		? `${actionContextKeys}, `
		: "";
	return `${thinkingKey}${checklistUpdateKey}${actionContextKeyList}tools`;
}

function getPreStepScreenshotPayloadDescription(): string {
	return configFeatureFlags.preStepScreenshotInLatestUserPrompt
		? `- currentPageScreenshotIncludedAsImagePart: true when a pre-step full-page screenshot is attached as an image part in the latest user message`
		: "";
}

function getRefSourceLabel(): string {
	return "the reconstructed current semantic projection";
}

function getRefValidityRule(): string {
	return "Must use a ref included in the reconstructed current semantic projection (never invent or reuse stale refs).";
}

function getPreStepScreenshotInstructions(): string {
	return configFeatureFlags.preStepScreenshotInLatestUserPrompt
		? `- The latest user message includes a current-viewport screenshot captured immediately before this step. Use it for spatial/visibility context, but choose actions from ${getRefSourceLabel()} and "interactionErrors" when they conflict.`
		: "";
}

function getUserTakeoverActionInstructions(): string {
	if (configFeatureFlags.userTakeoverTool) {
		return `- Required fields include category: "authentication" and request: "Sensitive step requiring manual user interaction (e.g. sign-in, payment, 2FA)."
- Use "user_takeover" ONLY for sensitive user-only interactions (e.g. entering passwords, payment details, OTP/2FA, or account verification steps).
- Always include "category". Use "authentication" for login credentials, "otp" for one-time codes/authenticator steps, "verification" for CAPTCHA/identity checks, "payment" for billing/payment entry, and "other" only when none of those fit.
- "user_takeover" requires a non-empty "request" string.
- When you use "user_takeover", do not include additional tool calls in the same step. Wait for the user to finish manual interaction and signal resume.`;
	}
	if (configFeatureFlags.authTakeover) {
		return `- Required fields include category: "authentication" and request: "Authentication is required to continue."
- Use "user_takeover" with category "authentication" only when the page requires sign-in credentials and authentication handling is needed to continue.
- "user_takeover" requires a non-empty "request" string.
- In this environment, the runtime may attempt supported authentication automatically after this tool call instead of asking the user directly.
- Do not use "user_takeover" for OTP, CAPTCHA, payment, or other manual verification flows when manual takeover is disabled.`;
	}
	return "";
}

function getExtractDataShorthandInstruction(): string {
	return configFeatureFlags.extractDataWholeContext
		? "  - extract_data: use the tool name only; the runtime sends the whole current document to the extractor"
		: "  - extract_data: the double-quoted scalar value is one ref or a comma-separated list of refs; extracted items are always written to memory_result";
}

function getExtractDataUsageInstructions(): string {
	if (configFeatureFlags.extractDataWholeContext) {
		return `  - Use the bare extract_data tool name with no argument.
  - The runtime sends the entire current semantic projection to the extractor in one call.
  - Do not provide a root, ref, range, or nested object.`;
	}
	return `  - Provide one scalar string containing one existing ref, or a comma-separated list of refs (for example, extract_data: "r2f,r8a").
  - Select every relevant container in that one call; extraction parses all result items from the selected subtrees together.
  - Root values must come from the reconstructed current projection. Never invent a ref, and never include an empty comma-separated segment.
  - Do not provide a nested object or extra range/output fields.`;
}

function usesCumulativeProjectionHistory(
	options: ExecutorPromptOptions = {},
): boolean {
	if (options.semanticProjectionHistory) {
		return options.semanticProjectionHistory === "cumulative";
	}
	return configFeatureFlags.semanticProjectionHistory === "cumulative";
}

function getProjectionHistoryPayloadDescription(
	options: ExecutorPromptOptions = {},
): string {
	if (!usesCumulativeProjectionHistory(options)) {
		return "- projection: complete semantic projection of the current page for this step";
	}
	return `- projectionContextMode: "reset" or "delta"
- projection: when mode is "reset", a complete semantic projection; when mode is "delta", a unified line delta from the immediately preceding reconstructed projection. An empty delta means page semantics are unchanged.`;
}

function getProjectionHistoryInstructions(
	options: ExecutorPromptOptions = {},
): string {
	if (!usesCumulativeProjectionHistory(options)) {
		return "";
	}
	return `- Reconstruct the current semantic projection chronologically from the most recent user payload whose projectionContextMode is "reset", then apply each later "delta" payload in order.
- Unified diff lines beginning with "-" were removed, lines beginning with "+" were added, and unprefixed/context lines are unchanged.
- A later "reset" payload replaces the earlier projection baseline completely. Do not combine projection content from before that reset with the new baseline.
- An empty projection value with projectionContextMode "delta" means the semantic page state is unchanged from the immediately preceding step.
- Target refs may appear in the reset baseline or any applied delta, but they are valid only while present in the fully reconstructed current projection.`;
}

function getExecutorActionContextPreamble(
	options: ExecutorPromptOptions,
): string {
	const thinkingExample = featureFlags.executorThinkingField
		? `thinking: |-
  The previous action revealed the search field, so the next useful step is to enter the query.
`
		: "";
	const actionContextExample = getExecutorContextPolicy(options)
		.executorActionContextFields
		? `previousStepStatus: "progressed"
previousStepOutcome: |-
  Opened the search form.
currentStateObservation: |-
  The search field is visible.
nextActionRationale: |-
  Enter the requested query.

`
		: "";
	return `${thinkingExample}${actionContextExample}`;
}

function getExecutorActionContextRules(options: ExecutorPromptOptions): string {
	const thinkingRule = featureFlags.executorThinkingField
		? `- thinking must always be present, must be used for any kind of reasoning, and MUST use YAML block scalar style: |-
`
		: "";
	const executorContextPolicy = getExecutorContextPolicy(options);
	const reasoningHistoryRule = executorContextPolicy.includeReasoningHistory
		? `- Prior assistant messages may include fallible reasoning from earlier executor steps. Use it only for continuity; the current payload and browser state remain the source of truth, and do not copy prior reasoning into your response.
`
		: "";
	const actionContextRules = executorContextPolicy.executorActionContextFields
		? `- When the current step has no meaningful previous browser action to assess (for example the first step), use previousStepStatus: "none" and leave the three short text fields as empty strings.
- previousStepStatus must be one of: "none", "progressed", "no_change", "blocked", "opened_tab", "switched_context", "partial"
- previousStepOutcome must be a short phrase describing what the previous step actually changed, and MUST use YAML block scalar style: |-
- currentStateObservation must be a short phrase describing one important fact from the current page, and MUST use YAML block scalar style: |-
- nextActionRationale must be a short phrase describing why the next tool call follows from the current state, and MUST use YAML block scalar style: |-
`
		: "";
	return `${thinkingRule}${reasoningHistoryRule}${actionContextRules}`;
}

function getExecutorSectionPayloadFormat(
	options: ExecutorPromptOptions = {},
): string {
	return `### Payload Format
Each step receives a YAML payload. Fields may be omitted when empty:
- task: overall task
- currentDateTime: runtime-local date/time and IANA zone
${CHECKLIST_PAYLOAD_DESCRIPTION}
- currentURL; currentTab and openTabs (switch_tab uses the zero-based index); newlyOpenedTabs
- downloadedFiles: safe "./..." paths; [DOWNLOADING] is incomplete and [NEW] completed this run
- workspaceFiles: discoverable safe "./..." paths; not an allowlist
- autoTabSwitchNote; interactionErrors from prior tools; toolObservations from completed/launched tools
- modelOutputErrors: precise contract errors from a rejected generation retry; no actions or checklist updates from that rejected generation were applied
${getProjectionHistoryPayloadDescription(options)}
${getPreStepScreenshotPayloadDescription()}
- latestUserPromptTokenCount
- memoryAvailable: memory_read can expose prepared context
- memoryContent: runtime-pinned workspace/file context, mutable browser scratchpad, and/or extracted page data/result memory.`;
}

function getExecutorSectionHtmlFormat(): string {
	return `### Semantic Projection Format
${PROJECTION_FORMAT_DESCRIPTION}
${PROJECTION_REF_NOTE}`;
}

function getExecutorSectionResponseFormat(
	options: ExecutorPromptOptions = {},
): string {
	const explicitResultExampleSource = "memoryContent";
	const resultSourceRule =
		"completed extract_data or memoryContent exposed by memory_read";
	const checklistUpdateExampleBlock = CHECKLIST_UPDATE_FORMAT_BLOCK;
	const actionContextExampleBlock = getExecutorActionContextPreamble(options);
	const textLikeScalarFields = `link, summary, downloaded_file_path, ref, path, root, text, url, script, request, value`;
	const actionContextRules = getExecutorActionContextRules(options);
	return `### Expected Output
Return only parseable YAML between <yaml> and </yaml>.

Example response:
<yaml>
${checklistUpdateExampleBlock}${actionContextExampleBlock}tools:
  - click: "r2"
  - type:
      ref: "r5"
      text: "browser automation"
      enter: true
</yaml>

Rules:
- All shown top-level response fields are mandatory except checklistUpdate. Each key (${getResponseKeyOrder(options)}) must appear once in that order.
${actionContextRules}- Quote all text fields (${textLikeScalarFields}) with double quotes.
- When modelOutputErrors is present, return a complete corrected response using the required wire form. Do not repeat the rejected action shape.
- Tool forms:
  - click: ref scalar; type: {ref, text, enter?}
  - long_press: {ref, durationMs?}; scroll: {ref, deltaX, deltaY}; dropdown_select: {ref, value}
  - switch_tab: index; wait: milliseconds; navigate: URL
  - upload_files: {ref, paths}; paste_file: {ref, path}; read_file: "./workspace/path" scalar
  - memory_write: text; memory_clear: "memory", "memory_result", or "all"
  - download_current_file, memory_read: bare tool name
${getExtractDataShorthandInstruction()}
- return_results: bare to return completed extraction unchanged, or a result list synthesized from ${explicitResultExampleSource}
${configFeatureFlags.agentTakeoverTool ? "  - agent_takeover: {request}\n" : ""}
- Use click for buttons, links, and custom-listbox options. Use type only for editable inputs; never type a control's visible label to activate it.
- Use only refs in the reconstructed current projection. For dates use YYYY-MM-DD. Set type.enter=true only when Enter is intended.
- Complete normally only with return_results grounded in ${resultSourceRule}. memory_read and return_results wait for pending extraction automatically; never poll it.
- Result items are {link, summary, downloaded_file_path?}. link and summary are mandatory. A downloaded_file_path must exactly match a completed "./..." entry in downloadedFiles.
${CHECKLIST_UPDATE_INSTRUCTIONS}
When the task is complete, use return_results instead of writing a result yourself.`;
}

function getExecutorSectionActions(
	options: ExecutorPromptOptions = {},
): string {
	const returnResultSources =
		"completed extract_data or memoryContent after memory_read";
	const explicitReturnResultSources = "memoryContent";
	return `### Tool Types & Usage
Use the smallest useful action set. Every ref must be present in the reconstructed current projection.

- click(ref): activate a control. long_press({ref,durationMs?}): only for explicit hold controls; duration is 100-15000 ms.
- type(ref,text,enter?): enter text; press Enter only intentionally. Dates must be YYYY-MM-DD.
- scroll({ref,deltaX,deltaY}): target the repeated-list/container ancestor when a child does not scroll.
- dropdown_select({ref,value}): native select using a listed option name/value. Use click for custom listbox options.
- evaluate(script): last resort after normal ref actions fail; never for scrolling. It may handle range drag or custom controls.
- wait(ms): normally <=1000; wait longer only while the page is unusable/loading.
- navigate(url): browser document URLs only (http(s), file/data, about); never mailto/tel/sms/intent/javascript/chrome protocols.
- switch_tab(index): zero-based openTabs index.
- download_current_file: save an inline file. Do not repeat while [DOWNLOADING]; finish only after the expected completed/[NEW] path appears in downloadedFiles.

upload_files:
  - Attach non-empty safe "./..." paths directly to the visible choose/attach/import/upload control. Never click that trigger first or use absolute/hidden/../ paths.
  - Prefer the visible trigger over a hidden file input. workspaceFiles aids discovery but is not an allowlist; an explicitly supplied safe path remains valid.

paste_file:
  - Paste exact text contents from a file into an editable ref. Use a safe "./..." path and prefer this over type/memory_read for exact bulk text.

memory_write:
  - Appends intermediate non-result notes to the mutable browser scratchpad; use sparingly and never with extract_data.

memory_read:
  - Expose scratchpad/extracted/pinned context in the next memoryContent. It automatically waits for pending extraction; never poll.
  - Extraction failure prevents the barrier and appears in interactionErrors on the next step.
  - For local file/document reasoning with absent context, read memory before navigating/uploading/searching. Use paste_file for exact field transfer.

read_file:
  - Read a safe workspace or completed downloadedFiles path into provenance-bearing result memory. Supports text, local Markdown conversion for CSV/DOCX/XLSX, PDF text layers, and image OCR; scanned PDFs without a text layer are unsupported.
  - Never use host/absolute/../ paths or batch with extract_data/memory_clear. Return unchanged with bare return_results or synthesize from memoryContent.

return_results:
  - The only normal completion tool. Use grounded ${returnResultSources}; it waits for pending extraction automatically.
  - Bare call returns completed extraction unchanged. To synthesize from ${explicitReturnResultSources}, provide {link, summary, downloaded_file_path?} items.

memory_clear:
  - Clear "memory", "memory_result", or "all". A same-batch replacement keeps old result memory unless new extraction succeeds.

extract_data:
  - Persist final-result page evidence asynchronously; prefer over memory_write. Continue normally, then use memory_read/return_results as the automatic barrier; never poll.
${getExtractDataUsageInstructions()}
  - Writes items to memory_result.

${
	configFeatureFlags.agentTakeoverTool
		? `agent_takeover:
  - Only for bounded local/workspace/downloaded-file work the browser cannot do: semantic inspection, conversion, extraction, moving/renaming, or exact artifact creation.
  - Use a supplied/listed safe "./..." source and a non-empty request containing output path/format and verification. Prefer outputs under ./downloads when based on a download.
  - Call alone; never use for web/page interaction or general reasoning. On the next step verify output paths and use returned memoryContent.

`
		: ""
}
${
	configFeatureFlags.userTakeoverTool || configFeatureFlags.authTakeover
		? `
user_takeover:
${getUserTakeoverActionInstructions()}
`
		: ""
}
${getPreStepScreenshotInstructions()}
${getProjectionHistoryInstructions(options)}
`;
}
const EXECUTOR_ROLE_SECTION = "You are a browser automation executor.";

function getExecutorPromptBlock(
	block: ExecutorPromptBlock,
	options: ExecutorPromptOptions,
): string {
	switch (block) {
		case "role":
			return EXECUTOR_ROLE_SECTION;
		case "payloadFormat":
			return getExecutorSectionPayloadFormat(options);
		case "projectionFormat":
			return getExecutorSectionHtmlFormat();
		case "responseFormat":
			return getExecutorSectionResponseFormat(options);
		case "actions":
			return getExecutorSectionActions(options);
	}
}

function buildExecutorSystem(options: ExecutorPromptOptions = {}): string {
	const blocks = options.blocks ?? EXECUTOR_PROMPT_BLOCKS_ALL;
	const base = blocks
		.map((block) => getExecutorPromptBlock(block, options))
		.filter((section) => section.length > 0)
		.join("\n\n");
	const customTools = getCustomToolsPrompt(options);
	return customTools ? `${base}\n\n${customTools}` : base;
}

export function getExecutorSystemBase(): string {
	return buildExecutorSystem({ forRunAgentStep: false });
}

export function getExecutorSystem(options: ExecutorPromptOptions = {}): string {
	return buildExecutorSystem({ ...options, forRunAgentStep: true });
}
