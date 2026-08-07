import yaml from "js-yaml";
import { chatYAML, userMessage } from "./providers/router.js";
import type {
	LLMOptions,
	Message,
	OpenAIPromptCacheRequest,
	ChecklistItem,
	StepResult,
	SuccessVerificationResult,
	SuccessVerificationVerdict,
	StageModelInvocationTrace,
} from "./types.js";
import { buildStageModelInvocationTrace } from "./model-invocation-tracing.js";
import { stripProjectionContextFromHistoryPayload } from "./executor-utils/history-payload.js";
import { estimateTokenCount as defaultEstimateTokenCount } from "./prompt-token-estimator.js";
import {
	estimateMessagesTokenCount,
	PromptBudgetExceededError,
	resolveMaxInputTokens,
	type PromptBudgetReport,
} from "../core/prompt-budget.js";

const SUCCESS_VERIFIER_SYSTEM = `You evaluate whether a browser automation run actually succeeded.

Your job is to classify task success, not whether the agent stopped.

You are given:
- the original task
- a lightweight stepHistory showing prior stripped user/assistant exchanges
- the final step emitted by the executor
- the final prompt payload / final browser state

Return success: true ONLY if the original task was fully completed and there is no hard basis to conclude otherwise.

Rules:
- Treat the agent's final "done" flag as only a claim that it stopped, not proof of success.
- Use the original task as the source of truth for required outcomes.
- Defer to the executor's judgment when you do NOT have a hard basis to overrule it.
- Do NOT fail a task merely because the final browser state does not independently prove every earlier intermediate action.
- Do NOT fail a task merely because evidence is limited, as long as it does not contradict the executor's claim and the task did not explicitly require that missing evidence.
- ONLY return success: false when at least one of these is true:
  1. The original task explicitly required specific evidence, data, artifact, or link, and the executor did not provide it.
  2. The supplied evidence directly contradicts the executor's claim.
  3. The executor's own final result or reasoning directly admits the task was not actually completed as required.
- A contradiction can come from the final browser state, downloadedFiles, workspaceFiles, interactionErrors, explicit filenames/links, or the executor's own words.
- If the executor plausibly completed the task and you cannot point to a concrete missing required artifact/evidence or a concrete contradiction, return success: true.

Respond with raw YAML only:
success: false
summary: "Short verdict summary."
reasons:
  - "Specific reason 1"
  - "Specific reason 2"`;

const COMPLETION_VERIFIER_SYSTEM = `You are an internal semantic completion verifier for a browser agent. A rejected candidate is returned to the executor so it can correct the task.

Your primary job is to compare the original task, the cumulative checklist, and the candidate result for semantic correctness and completeness.

Important result-format rule:
- The candidate result is serialized by the browser-agent runtime as a YAML list of objects with mandatory link and summary fields. This is a transport envelope, not user-authored answer formatting.
- For a single-answer task, treat the content of the result item's summary as the candidate answer.
- Apply requests for an integer, date, name, phrase, answer without punctuation, or similar formatting to the summary content only.
- Ignore unavoidable YAML syntax, list markers, link fields, and summary labels when evaluating those formatting requests.
- Never reject a semantically correct result merely because the transport envelope contains a link, list item, summary field, YAML syntax, or other mandatory serialization.
- A link remains a semantic deliverable when the original task explicitly requests links.

Decision priority:
1. The original task is authoritative.
2. Check whether the semantic content contains every requested entity, field, count, range, date, unit, filter, ordering, and negation.
3. Use the checklist to make omissions explicit, but correct it when it missed an original requirement.
4. When supplied, step history and browser metadata are supporting context for identifying concrete errors, omissions, contradictions, or admitted incompleteness.

Reject only for a specific defect you can describe precisely, including:
- a required result, field, entity, condition, or constraint is absent
- a returned value conflicts with the task or supplied context
- only part of a requested list or metadata set was returned
- the result is internally inconsistent or admits incomplete execution
- supplied browser context concretely contradicts the claimed outcome

Do not reject merely because earlier browser evidence is unavailable, an action lacks independent proof, the final page does not prove an earlier action, or a checklist status is stale. Missing independent evidence is not itself a failure.
Do not reject for transport-envelope formatting or instruct the executor to remove mandatory link, summary, list, or YAML structure. If the only remaining issue is the unavoidable result envelope, return success: true.
Do not use external knowledge.

Keep output minimal. On success, return only:
success: true

On rejection, return:
success: false
summary: "One precise correction instruction."
reopen:
  - "C2"
add:
  - "A concise original-task requirement omitted by the checklist."
regenerate: true

Omit reopen, add, or regenerate when unnecessary. Use regenerate: true only when the checklist decomposition is broadly unusable, not for one missing requirement. Never include benchmark ground truth.`;

export interface VerifyTaskSuccessInput {
	task: string;
	executedSteps: number;
	maxSteps?: number;
	finalStep: StepResult;
	finalPromptPayload: Record<string, unknown>;
	checklist?: ChecklistItem[];
	purpose?: "terminal_judge" | "completion_verifier";
	contextMode?: "full" | "compact";
	historyMessages?: Message[];
	llmOptions: LLMOptions;
	openAIPromptCache?: OpenAIPromptCacheRequest;
	estimateTokenCount?: (text: string) => number;
	caller?: string;
	onTrace?: (trace: StageModelInvocationTrace) => void;
	traceMeta?: Record<string, unknown>;
}

interface CompactCompletionVerdict {
	success?: unknown;
	summary?: unknown;
	reasons?: unknown;
	reopen?: unknown;
	add?: unknown;
	regenerate?: unknown;
}

function normalizeReasons(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(entry): entry is string =>
			typeof entry === "string" && entry.trim().length > 0,
	);
}

function normalizeVerdict(
	raw: SuccessVerificationVerdict & CompactCompletionVerdict,
): SuccessVerificationVerdict {
	const normalizeStringList = (value: unknown): string[] | undefined => {
		if (!Array.isArray(value)) return undefined;
		const result = value
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim())
			.filter(Boolean);
		return result.length > 0 ? result : undefined;
	};
	const summary =
		typeof raw.summary === "string" && raw.summary.trim().length > 0
			? raw.summary.trim()
			: raw.success
				? "Task succeeded."
				: "Task failed success verification.";
	return {
		success: raw.success === true,
		summary,
		reasons: normalizeReasons(raw.reasons).length
			? normalizeReasons(raw.reasons)
			: raw.success === true
				? []
				: [summary],
		reopenChecklistItemIds: normalizeStringList(raw.reopen),
		addChecklistItems: normalizeStringList(raw.add),
		regenerateChecklist: raw.regenerate === true || undefined,
	};
}

function normalizeMessageContent(content: Message["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	const textParts: string[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		}
	}
	return textParts.join("\n").trim();
}

function serializeHistoryMessages(messages: Message[] | undefined): Array<{
	role: "user" | "assistant";
	content: string;
}> {
	if (!Array.isArray(messages)) {
		return [];
	}
	return messages
		.filter(
			(message): message is Message & { role: "user" | "assistant" } =>
				message.role === "user" || message.role === "assistant",
		)
		.map((message) => ({
			role: message.role,
			content: normalizeMessageContent(message.content),
		}))
		.filter((message) => message.content.length > 0);
}

export async function verifyTaskSuccess(
	input: VerifyTaskSuccessInput,
): Promise<SuccessVerificationResult> {
	const { messages, purpose, contextMode, budgetMode, budgetReport } =
		fitSuccessVerificationPromptToBudget(input);
	if (budgetReport.reductions.length > 0) {
		console.log(
			`[prompt-budget] stage=verifySuccess purpose=${purpose} mode=${budgetMode} ` +
				`initial_input_tokens=${budgetReport.initialInputTokens} ` +
				`final_input_tokens=${budgetReport.finalInputTokens} ` +
				`max_input_tokens=${budgetReport.maxInputTokens ?? "unbounded"} ` +
				`reductions=${budgetReport.reductions.join(",")}`,
		);
	}

	const { data, usage } = await chatYAML<
		SuccessVerificationVerdict & CompactCompletionVerdict
	>(
		messages,
		input.llmOptions,
		input.caller ?? "verifyTaskSuccess",
		(trace) =>
			input.onTrace?.(
				buildStageModelInvocationTrace({
					stage: "verifySuccess",
					trace,
					meta: {
						...input.traceMeta,
						purpose,
						contextMode,
						budgetMode,
						promptBudget: budgetReport,
					},
				}),
			),
		undefined,
		undefined,
		undefined,
		input.openAIPromptCache,
	);
	const verdict = normalizeVerdict(data);

	return {
		...verdict,
		model: input.llmOptions.model,
		provider: input.llmOptions.provider,
		reasoningEffort: input.llmOptions.reasoningEffort,
		usage,
	};
}

function slimVerifierHistoryMessage(message: Message): Message {
	if (typeof message.content !== "string") return message;
	let parsed: unknown;
	try {
		parsed = yaml.load(message.content);
	} catch {
		return message;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return message;
	}
	const payload = { ...(parsed as Record<string, unknown>) };
	stripProjectionContextFromHistoryPayload(payload);
	delete payload.thinking;
	delete payload.reasoning;
	delete payload.reasoningTokens;
	return { ...message, content: yaml.dump(payload) };
}

function slimFinalPromptPayload(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...payload };
	for (const key of [
		"projection",
		"projectionContextMode",
		"currentPageScreenshotIncludedAsImagePart",
		"latestUserPromptTokenCount",
	]) {
		delete next[key];
	}
	return next;
}

export interface FittedSuccessVerificationPrompt {
	messages: Message[];
	purpose: "terminal_judge" | "completion_verifier";
	contextMode: "full" | "compact";
	budgetMode: "full" | "budgeted_full" | "compact";
	budgetReport: PromptBudgetReport;
}

export function fitSuccessVerificationPromptToBudget(
	input: VerifyTaskSuccessInput,
): FittedSuccessVerificationPrompt {
	const estimateTokenCount =
		input.estimateTokenCount ?? defaultEstimateTokenCount;
	const maxInputTokens = resolveMaxInputTokens(input.llmOptions);
	const initial = buildSuccessVerificationMessages(input);
	const initialInputTokens = estimateMessagesTokenCount(
		initial.messages,
		estimateTokenCount,
	);
	const reductions: string[] = [];
	const finish = (
		built: ReturnType<typeof buildSuccessVerificationMessages>,
		budgetMode: FittedSuccessVerificationPrompt["budgetMode"],
	): FittedSuccessVerificationPrompt => ({
		...built,
		budgetMode,
		budgetReport: {
			maxInputTokens,
			initialInputTokens,
			finalInputTokens: estimateMessagesTokenCount(
				built.messages,
				estimateTokenCount,
			),
			reductions: [...reductions],
		},
	});

	if (maxInputTokens === null || initialInputTokens <= maxInputTokens) {
		return finish(
			initial,
			initial.contextMode === "compact" ? "compact" : "full",
		);
	}

	let fittedInput: VerifyTaskSuccessInput = {
		...input,
		finalPromptPayload: slimFinalPromptPayload(input.finalPromptPayload),
		finalStep: {
			...input.finalStep,
			thinking: "",
		},
		historyMessages: input.historyMessages?.map(slimVerifierHistoryMessage),
	};
	reductions.push("strip_redundant_full_context");
	let built = buildSuccessVerificationMessages(fittedInput);
	let tokenCount = estimateMessagesTokenCount(
		built.messages,
		estimateTokenCount,
	);
	while (
		tokenCount > maxInputTokens &&
		(fittedInput.historyMessages?.length ?? 0) > 0
	) {
		fittedInput = {
			...fittedInput,
			historyMessages: fittedInput.historyMessages?.slice(
				Math.min(2, fittedInput.historyMessages.length),
			),
		};
		reductions.push("drop_oldest_history_pair");
		built = buildSuccessVerificationMessages(fittedInput);
		tokenCount = estimateMessagesTokenCount(built.messages, estimateTokenCount);
	}
	if (tokenCount <= maxInputTokens) {
		return finish(built, "budgeted_full");
	}

	reductions.push("fallback_to_compact");
	built = buildSuccessVerificationMessages({
		...input,
		contextMode: "compact",
	});
	tokenCount = estimateMessagesTokenCount(built.messages, estimateTokenCount);
	if (tokenCount > maxInputTokens) {
		throw new PromptBudgetExceededError({
			caller: input.caller ?? "verifyTaskSuccess",
			estimatedInputTokens: tokenCount,
			maxInputTokens,
		});
	}
	return finish(built, "compact");
}

export function buildSuccessVerificationMessages(
	input: VerifyTaskSuccessInput,
): {
	messages: Message[];
	purpose: "terminal_judge" | "completion_verifier";
	contextMode: "full" | "compact";
} {
	const purpose = input.purpose ?? "terminal_judge";
	const contextMode = input.contextMode ?? "full";
	const checklist = (input.checklist ?? []).map((item) => ({
		id: item.id,
		requirement: item.requirement,
		status: item.status,
	}));
	const compactPayload = {
		task: input.task,
		checklist,
		candidateResult: input.finalStep.result ?? null,
	};
	const compactTerminalPayload = {
		task: input.task,
		executedSteps: input.executedSteps,
		maxSteps: input.maxSteps,
		finalStep: {
			done: input.finalStep.done,
			result: input.finalStep.result ?? null,
		},
	};
	const userPayload =
		contextMode === "compact"
			? purpose === "completion_verifier"
				? compactPayload
				: compactTerminalPayload
			: {
					task: input.task,
					...(purpose === "completion_verifier" ? { checklist } : {}),
					executedSteps: input.executedSteps,
					maxSteps: input.maxSteps,
					stepHistory: serializeHistoryMessages(input.historyMessages),
					finalStep: {
						thinking: input.finalStep.thinking,
						checklistUpdate: input.finalStep.checklistUpdate,
						tools: input.finalStep.actions,
						done: input.finalStep.done,
						result: input.finalStep.result ?? null,
					},
					finalPromptPayload: input.finalPromptPayload,
				};
	const messages: Message[] = [
		{
			role: "system",
			content:
				purpose === "completion_verifier"
					? COMPLETION_VERIFIER_SYSTEM
					: SUCCESS_VERIFIER_SYSTEM,
		},
		userMessage(yaml.dump(userPayload)),
	];
	return { messages, purpose, contextMode };
}
