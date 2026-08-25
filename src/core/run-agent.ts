import * as fs from "fs";
import type { ModelMessage } from "ai";
import yaml from "js-yaml";
import { MAX_STEPS } from "../agents/constants.js";
import { MAX_STEP_FINALIZATION_INSTRUCTION } from "../agents/prompts.js";
import { chatYAML } from "../agents/providers/router.js";
import type {
	ChatJSONResult,
	MainLoopStepEntry,
	StepResult as ModelStepResult,
	StepTokenUsage,
	TokenUsage,
} from "../agents/types.js";
import { getDefaultBrowserAgentArtifactDirectories } from "../browser/constants.js";
import { createSessionAuthTakeoverState } from "../auth/crypto.js";
import {
	logStepActionContext,
	logStepModelResponse,
	saveStepContextIfNeeded,
	serializeMessagesForDisk,
} from "../agents/executor-utils/step-execution.js";
import { configFeatureFlags } from "../config-feature-flags.js";
import { supportsOpenAIExplicitPromptCaching } from "../llm-capabilities.js";
import { resolveExecutorContextPolicy } from "../agents/executor-context-policy.js";
import {
	buildOpenAIExplicitNoCacheRequest,
	buildOpenAIPromptCacheRequest,
} from "../agents/openai-prompt-cache.js";
import { shouldSaveStepsContext } from "../runtime-options.js";
import { createDefaultCoreDeps } from "./deps.js";
import {
	MAX_STEP_RETRIES,
	STAGNATION_NO_PROGRESS_THRESHOLD,
	STAGNATION_SAME_ACTION_THRESHOLD,
	buildActionSignatureWithUrl,
	buildProgressSignature,
} from "./run-agent-loop-state.js";
import {
	applyVerifierChecklistChanges,
	cloneChecklist,
	normalizeChecklistDraft,
	replaceChecklistPreservingDone,
} from "./checklist-state.js";
import { closeSession, createSession } from "./session.js";
import { preprocessTask } from "./preprocess-task.js";
import {
	ModelStepActionContractError,
	processModelStepOutput,
} from "./process-model-step-output.js";
import {
	createPromptForStep,
	processModelOutputAndBrowse,
	processStepModelOutput,
} from "./step.js";
import type {
	CoreDeps,
	RunAgentGenerateStep,
	RunAgentInput,
	RunAgentResult,
	RunAgentStepArtifact,
	RunAgentTokenTotals,
	StepHistoryEntry,
	StepRuntimeMetrics,
	ValidatorFeedback,
	ValidatorLifecycleOptions,
} from "./types.js";
import type { BrowserSession } from "./session-registry.js";
import type { UserTakeoverCategory } from "../user-action-types.js";
import { shouldLogTimingDuration } from "../timing-logs.js";
import {
	DEFAULT_EXECUTOR_STEP_DELAY_MS,
	canSkipExecutorStepDelay,
} from "./executor-step-delay.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_VALIDATOR_LIFECYCLE: ValidatorLifecycleOptions = {
	mode: "retry",
	maxFailures: 3,
	context: "full",
};

function resolveValidatorLifecycle(
	value: RunAgentInput["validatorLifecycle"],
): ValidatorLifecycleOptions {
	if (!value) return DEFAULT_VALIDATOR_LIFECYCLE;
	if (
		value.mode !== "terminal" &&
		value.mode !== "retry" &&
		value.mode !== "disabled"
	) {
		throw new Error(
			"validatorLifecycle must use mode terminal|retry|disabled.",
		);
	}
	if (
		!Number.isInteger(value.maxFailures) ||
		value.maxFailures < 1 ||
		value.maxFailures > 3
	) {
		throw new Error("validatorLifecycle maxFailures must be between 1 and 3.");
	}
	if (
		value.context !== undefined &&
		value.context !== "full" &&
		value.context !== "compact"
	) {
		throw new Error("validatorLifecycle context must use full|compact.");
	}
	return { ...value, context: value.context ?? "full" };
}

function truncateFeedbackText(value: string, maxChars: number): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()}… [truncated]`;
}

function buildValidatorFeedback(params: {
	failure: number;
	maxFailures: number;
	verification: NonNullable<RunAgentResult["successVerification"]>;
	reopenChecklistItemIds?: string[];
	addedChecklistItemIds?: string[];
}): ValidatorFeedback {
	return {
		failure: params.failure,
		maxFailures: params.maxFailures,
		summary: truncateFeedbackText(params.verification.summary, 500),
		reasons: params.verification.reasons
			.slice(0, 3)
			.map((reason) => truncateFeedbackText(reason, 400)),
		instruction:
			"The completion verifier rejected the attempted final result. Continue the task, correct the specific missing or wrong result content, then return a complete corrected result. Do not merely restate the rejected answer.",
		reopenChecklistItemIds: params.reopenChecklistItemIds,
		addedChecklistItemIds: params.addedChecklistItemIds,
	};
}

function sumTokenUsage(usages: TokenUsage[]): RunAgentTokenTotals {
	return usages.reduce<RunAgentTokenTotals>(
		(acc, usage) => ({
			input_tokens: acc.input_tokens + usage.input_tokens,
			cached_input_tokens:
				acc.cached_input_tokens + (usage.cached_input_tokens ?? 0),
			cache_write_tokens:
				acc.cache_write_tokens + (usage.cache_write_tokens ?? 0),
			output_tokens: acc.output_tokens + usage.output_tokens,
			total_tokens: acc.total_tokens + usage.total_tokens,
		}),
		{
			input_tokens: 0,
			cached_input_tokens: 0,
			cache_write_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
		},
	);
}

function combineStepAttemptUsage(usages: TokenUsage[]): TokenUsage {
	const combined: TokenUsage = {
		input_tokens: 0,
		cached_input_tokens: 0,
		cache_write_tokens: 0,
		output_tokens: 0,
		total_tokens: 0,
	};
	let hasReasoningTokens = false;
	let hasNonReasoningOutputTokens = false;
	let hasGenerationTime = false;
	let hasTimeToFirstToken = false;
	for (const usage of usages) {
		combined.input_tokens += usage.input_tokens;
		combined.cached_input_tokens =
			(combined.cached_input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
		combined.cache_write_tokens =
			(combined.cache_write_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
		combined.output_tokens += usage.output_tokens;
		combined.total_tokens += usage.total_tokens;
		if (typeof usage.reasoning_tokens === "number") {
			hasReasoningTokens = true;
			combined.reasoning_tokens =
				(combined.reasoning_tokens ?? 0) + usage.reasoning_tokens;
		}
		if (typeof usage.non_reasoning_output_tokens === "number") {
			hasNonReasoningOutputTokens = true;
			combined.non_reasoning_output_tokens =
				(combined.non_reasoning_output_tokens ?? 0) +
				usage.non_reasoning_output_tokens;
		}
		if (typeof usage.generation_time_ms === "number") {
			hasGenerationTime = true;
			combined.generation_time_ms =
				(combined.generation_time_ms ?? 0) + usage.generation_time_ms;
		}
		if (typeof usage.time_to_first_token_ms === "number") {
			hasTimeToFirstToken = true;
			combined.time_to_first_token_ms = usage.time_to_first_token_ms;
		}
	}
	if (!hasReasoningTokens) delete combined.reasoning_tokens;
	if (!hasNonReasoningOutputTokens) {
		delete combined.non_reasoning_output_tokens;
	}
	if (!hasGenerationTime) delete combined.generation_time_ms;
	if (!hasTimeToFirstToken) delete combined.time_to_first_token_ms;
	return combined;
}

function buildStepTokenUsage(step: number, usage?: TokenUsage): StepTokenUsage {
	const result: StepTokenUsage = {
		step,
		input_tokens: usage?.input_tokens ?? 0,
		cached_input_tokens: usage?.cached_input_tokens ?? 0,
		cache_write_tokens: usage?.cache_write_tokens ?? 0,
		output_tokens: usage?.output_tokens ?? 0,
		total_tokens: usage?.total_tokens ?? 0,
	};
	if (
		usage &&
		("reasoning_tokens" in usage || "non_reasoning_output_tokens" in usage)
	) {
		result.reasoning_tokens = usage.reasoning_tokens;
		result.non_reasoning_output_tokens = usage.non_reasoning_output_tokens;
	}
	return result;
}

function isCoreDeps(value: unknown): value is CoreDeps {
	if (!value || typeof value !== "object") {
		return false;
	}
	return (
		"registry" in value && "launchBrowser" in value && "featureFlags" in value
	);
}

class RunAgentAbortError extends Error {
	constructor(reason?: unknown) {
		super(
			reason instanceof Error ? reason.message : "Browser agent run cancelled.",
		);
		this.name = "AbortError";
	}
}

function createRunAgentAbortError(signal?: AbortSignal) {
	return new RunAgentAbortError(signal?.reason);
}

function isAbortError(error: unknown) {
	return (
		error instanceof Error &&
		(error.name === "AbortError" ||
			error.message === "Browser agent run cancelled.")
	);
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) {
		throw createRunAgentAbortError(signal);
	}
}

async function withAbort<T>(
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	throwIfAborted(signal);
	const operation = run();
	if (!signal) {
		return await operation;
	}
	let handleAbort: (() => void) | null = null;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				handleAbort = () => reject(createRunAgentAbortError(signal));
				signal.addEventListener("abort", handleAbort, { once: true });
			}),
		]);
	} finally {
		if (handleAbort) {
			signal.removeEventListener("abort", handleAbort);
		}
	}
}

function createDefaultGenerateStep(): RunAgentGenerateStep {
	return async ({
		stepNumber,
		messages,
		llmOptions,
		caller,
		abortSignal,
		openAIEncryptedResponses,
		openAIPromptCache,
	}): Promise<ChatJSONResult<ModelStepResult>> =>
		await chatYAML<ModelStepResult>(
			messages,
			llmOptions,
			caller ?? `runAgent:step${stepNumber}`,
			undefined,
			abortSignal,
			undefined,
			openAIEncryptedResponses,
			openAIPromptCache,
		);
}

function serializeStepContextForDisk(
	messages: ModelMessage[],
): RunAgentStepArtifact["contextJson"] {
	return serializeMessagesForDisk(messages);
}

function isSerializableAuthMessage(value: unknown): value is ModelMessage {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const role = record.role;
	if (
		role !== "system" &&
		role !== "user" &&
		role !== "assistant" &&
		role !== "tool"
	) {
		return false;
	}
	const content = record.content;
	if (typeof content === "string") return true;
	if (!Array.isArray(content)) return false;
	return content.every((part) => {
		if (!part || typeof part !== "object") return false;
		const contentPart = part as Record<string, unknown>;
		if (contentPart.type === "text") {
			return typeof contentPart.text === "string";
		}
		return typeof contentPart.type === "string";
	});
}

function serializeAuthAttemptMessages(
	messages: unknown[] | undefined,
): unknown[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		return [];
	}
	return serializeMessagesForDisk(messages.filter(isSerializableAuthMessage));
}

interface StepPartTimingEntry {
	part: string;
	durationMs: number;
}

async function measureStepPart<T>(params: {
	timings: StepPartTimingEntry[];
	part: string;
	run: () => T | Promise<T>;
}): Promise<T> {
	const startedAt = Date.now();
	try {
		return await params.run();
	} finally {
		params.timings.push({
			part: params.part,
			durationMs: Date.now() - startedAt,
		});
	}
}

const BROWSER_INTERACTION_TIMING_PARTS = new Set([
	"process_model_output_and_browse",
	"process_step_model_output",
	"wait_for_settle",
]);

function computeStepTimingSplit(params: {
	timings: StepPartTimingEntry[];
	totalDurationMs: number;
	usage?: TokenUsage;
}): Pick<StepRuntimeMetrics, "tokenGenerationMs" | "browserInteractionMs"> {
	const sumParts = (parts: Set<string>) =>
		params.timings.reduce(
			(total, entry) =>
				parts.has(entry.part) ? total + entry.durationMs : total,
			0,
		);
	const llmDecisionMs = sumParts(new Set(["llm_step_call"]));
	const browserInteractionMs = sumParts(BROWSER_INTERACTION_TIMING_PARTS);
	const tokenGenerationMs =
		typeof params.usage?.generation_time_ms === "number"
			? params.usage.generation_time_ms
			: llmDecisionMs;
	return { tokenGenerationMs, browserInteractionMs };
}

function logStepPartTimings(params: {
	stepNumber: number;
	timings: StepPartTimingEntry[];
	totalDurationMs: number;
	usage?: TokenUsage;
}): void {
	if (!shouldLogTimingDuration(params.totalDurationMs)) return;
	const { tokenGenerationMs, browserInteractionMs } =
		computeStepTimingSplit(params);
	const stateExtractionMs = Math.max(
		0,
		params.totalDurationMs - tokenGenerationMs - browserInteractionMs,
	);
	const parts = params.timings.map(
		(entry) => `${entry.part}=${entry.durationMs}ms`,
	);
	parts.push(`total=${params.totalDurationMs}ms`);
	console.log(`  [step ${params.stepNumber} timings] ${parts.join(" | ")}`);
	console.log(
		`  [step ${params.stepNumber} timing-split] state_extraction_ms=${stateExtractionMs} | llm_decision_ms=${tokenGenerationMs} | tool_execution_ms=${browserInteractionMs}`,
	);
}

function recordStepRuntimeMetrics(params: {
	stepRuntimeMetrics: StepRuntimeMetrics[];
	stepNumber: number;
	timings: StepPartTimingEntry[];
	totalDurationMs: number;
	usage?: TokenUsage;
}): void {
	const split = computeStepTimingSplit({
		timings: params.timings,
		totalDurationMs: params.totalDurationMs,
		usage: params.usage,
	});
	params.stepRuntimeMetrics.push({
		stepNumber: params.stepNumber,
		totalDurationMs: params.totalDurationMs,
		tokenGenerationMs: split.tokenGenerationMs,
		browserInteractionMs: split.browserInteractionMs,
	});
	logStepPartTimings({
		stepNumber: params.stepNumber,
		timings: params.timings,
		totalDurationMs: params.totalDurationMs,
		usage: params.usage,
	});
}

function emitStagnationWarning(
	session: BrowserSession,
	stepNumber: number,
): void {
	if (
		session.sameActionSignatureStreak !== STAGNATION_SAME_ACTION_THRESHOLD &&
		session.noProgressStreak !== STAGNATION_NO_PROGRESS_THRESHOLD
	) {
		return;
	}
	console.warn(
		JSON.stringify({
			event: "browser_agent.stagnation_detected",
			timestamp: new Date().toISOString(),
			level: "warning",
			payload: {
				step: stepNumber,
				same_action_signature_streak: session.sameActionSignatureStreak,
				no_progress_streak: session.noProgressStreak,
				thresholds: {
					same_action_signature: STAGNATION_SAME_ACTION_THRESHOLD,
					no_progress: STAGNATION_NO_PROGRESS_THRESHOLD,
				},
			},
		}),
	);
}

function authProtectedProjectionOptions(session: BrowserSession): {
	redactInputRefs?: string[];
	redactPasswordInputs?: boolean;
} {
	if (!session.authTakeover || session.authTakeover.protectedRefs.size === 0) {
		return {};
	}
	return {
		redactInputRefs: [...session.authTakeover.protectedRefs],
		redactPasswordInputs: true,
	};
}

async function regenerateChecklistAfterVerification(params: {
	deps: CoreDeps;
	input: RunAgentInput;
	session: BrowserSession;
	verification: NonNullable<RunAgentResult["successVerification"]>;
	stepNumber: number;
}): Promise<void> {
	try {
		const raw = await params.deps.createChecklist(
			params.input.task,
			params.input.stageLLMs.createChecklist,
			{
				onTrace: params.input.recordModelInvocation,
				meta: {
					phase: "verifier_regeneration",
					stepNumber: params.stepNumber,
				},
			},
			{
				existingChecklist: params.session.activeChecklist,
				verifierSummary: params.verification.summary,
			},
		);
		const normalized = normalizeChecklistDraft(raw);
		if (!normalized) {
			console.warn(
				"[runAgent] verifier-requested checklist regeneration returned an invalid checklist; keeping the existing checklist",
			);
			return;
		}
		params.session.activeChecklist = replaceChecklistPreservingDone(
			params.session.activeChecklist,
			normalized.items,
		);
	} catch (error) {
		console.warn(
			`[runAgent] verifier-requested checklist regeneration failed; keeping the existing checklist: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

interface SessionSnapshot {
	activeChecklist: BrowserSession["activeChecklist"];
	lastTask: string | null;
	pendingMemoryRead: boolean;
	previousInteractionErrors: string[];
	previousToolObservations: string[];
	previousStepTabs: BrowserSession["previousStepTabs"];
	pendingAutoSwitchRecovery: BrowserSession["pendingAutoSwitchRecovery"];
	downloadedFileSignatures: BrowserSession["downloadedFileSignatures"];
	downloadedNewFilePaths: Set<string>;
	lastActionSignatureWithUrl: string | null;
	lastProgressSignature: string | null;
	sameActionSignatureStreak: number;
	noProgressStreak: number;
	projectionHistory: BrowserSession["projectionHistory"];
	dataExtractionCheckpoint: ReturnType<
		BrowserSession["dataExtractionCoordinator"]["checkpoint"]
	>;
	memoryFileContents: string;
	extractDataMemoryFileContents: string;
}

function cloneDownloadedFileSignatures(
	value: BrowserSession["downloadedFileSignatures"],
): BrowserSession["downloadedFileSignatures"] {
	return value ? new Map(value) : null;
}

function snapshotSession(session: BrowserSession): SessionSnapshot {
	return {
		activeChecklist: cloneChecklist(session.activeChecklist),
		lastTask: session.lastTask,
		pendingMemoryRead: session.pendingMemoryRead,
		previousInteractionErrors: [...session.previousInteractionErrors],
		previousToolObservations: [...session.previousToolObservations],
		previousStepTabs: session.previousStepTabs
			? session.previousStepTabs.map((tab) => ({ ...tab }))
			: null,
		pendingAutoSwitchRecovery: session.pendingAutoSwitchRecovery
			? { ...session.pendingAutoSwitchRecovery }
			: undefined,
		downloadedFileSignatures: cloneDownloadedFileSignatures(
			session.downloadedFileSignatures,
		),
		downloadedNewFilePaths: new Set(session.downloadedNewFilePaths),
		lastActionSignatureWithUrl: session.lastActionSignatureWithUrl,
		lastProgressSignature: session.lastProgressSignature,
		sameActionSignatureStreak: session.sameActionSignatureStreak,
		noProgressStreak: session.noProgressStreak,
		projectionHistory: {
			committed: session.projectionHistory.committed
				? { ...session.projectionHistory.committed }
				: undefined,
			pending: session.projectionHistory.pending
				? { ...session.projectionHistory.pending }
				: undefined,
		},
		dataExtractionCheckpoint: session.dataExtractionCoordinator.checkpoint(),
		memoryFileContents: (() => {
			try {
				return fs.readFileSync(session.memoryFile, "utf-8");
			} catch {
				return "";
			}
		})(),
		extractDataMemoryFileContents: (() => {
			try {
				return fs.readFileSync(session.extractDataMemoryFile, "utf-8");
			} catch {
				return "";
			}
		})(),
	};
}

async function restoreSession(
	session: BrowserSession,
	snapshot: SessionSnapshot,
): Promise<void> {
	session.activeChecklist = cloneChecklist(snapshot.activeChecklist);
	session.lastTask = snapshot.lastTask;
	session.pendingMemoryRead = snapshot.pendingMemoryRead;
	session.previousInteractionErrors = [...snapshot.previousInteractionErrors];
	session.previousToolObservations = [...snapshot.previousToolObservations];
	session.previousStepTabs = snapshot.previousStepTabs
		? snapshot.previousStepTabs.map((tab) => ({ ...tab }))
		: null;
	session.pendingAutoSwitchRecovery = snapshot.pendingAutoSwitchRecovery
		? { ...snapshot.pendingAutoSwitchRecovery }
		: undefined;
	session.downloadedFileSignatures = cloneDownloadedFileSignatures(
		snapshot.downloadedFileSignatures,
	);
	session.downloadedNewFilePaths = new Set(snapshot.downloadedNewFilePaths);
	session.lastActionSignatureWithUrl = snapshot.lastActionSignatureWithUrl;
	session.lastProgressSignature = snapshot.lastProgressSignature;
	session.sameActionSignatureStreak = snapshot.sameActionSignatureStreak;
	session.noProgressStreak = snapshot.noProgressStreak;
	session.projectionHistory = {
		committed: snapshot.projectionHistory.committed
			? { ...snapshot.projectionHistory.committed }
			: undefined,
		pending: snapshot.projectionHistory.pending
			? { ...snapshot.projectionHistory.pending }
			: undefined,
	};
	session.dataExtractionCoordinator.rollback(snapshot.dataExtractionCheckpoint);
	fs.writeFileSync(session.memoryFile, snapshot.memoryFileContents, "utf-8");
	fs.writeFileSync(
		session.extractDataMemoryFile,
		snapshot.extractDataMemoryFileContents,
		"utf-8",
	);
}

function resolveBrowserAgentArtifactDirectories(
	input: RunAgentInput["artifactDirectories"],
) {
	const defaults = getDefaultBrowserAgentArtifactDirectories();
	return {
		stepsDir: input?.stepsDir ?? defaults.stepsDir,
		contextDir: input?.contextDir ?? defaults.contextDir,
	};
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult>;

export async function runAgent(
	deps: CoreDeps,
	input: RunAgentInput,
): Promise<RunAgentResult>;

export async function runAgent(
	depsOrInput: CoreDeps | RunAgentInput,
	maybeInput?: RunAgentInput,
): Promise<RunAgentResult> {
	const rawInput = isCoreDeps(depsOrInput) ? maybeInput : depsOrInput;
	if (!rawInput) {
		throw new Error("runAgent input is required.");
	}
	const validatorLifecycle = resolveValidatorLifecycle(
		rawInput.validatorLifecycle,
	);
	const successVerifierLLMOptions = isCoreDeps(depsOrInput)
		? (depsOrInput.defaultSuccessVerifierLLMOptions ??
			rawInput.stageLLMs.verifySuccess)
		: rawInput.stageLLMs.verifySuccess;
	if (validatorLifecycle.mode !== "disabled" && !successVerifierLLMOptions) {
		throw new Error(
			"Browser success verification requires an explicit stageLLMs.verifySuccess model configuration.",
		);
	}
	const baseDeps = isCoreDeps(depsOrInput)
		? {
				...depsOrInput,
				waitForAutomationPermission:
					depsOrInput.waitForAutomationPermission ?? (async () => {}),
				defaultSuccessVerifierLLMOptions:
					depsOrInput.defaultSuccessVerifierLLMOptions ??
					successVerifierLLMOptions,
			}
		: createDefaultCoreDeps({
				featureFlags: depsOrInput.featureFlags,
				userActionBehavior: depsOrInput.userActionBehavior,
				onUserActionRequired: depsOrInput.onUserActionRequired,
				requestAgentTakeover: depsOrInput.requestAgentTakeover,
				defaultSuccessVerifierLLMOptions: successVerifierLLMOptions,
			});
	const deps: CoreDeps = {
		...baseDeps,
		getPageProjection: (browser, options) =>
			baseDeps.getPageProjection(browser, {
				...options,
				omitHrefs: options?.preserveFullHrefs !== true,
			}),
	};
	const input = rawInput;
	const abortSignal = input.abortSignal;
	throwIfAborted(abortSignal);
	await input.onRunStarted?.({
		task: input.task,
		session: input.session,
	});

	const stepsHistory: StepHistoryEntry[] = [];
	const usages: TokenUsage[] = [];
	const steps: RunAgentResult["steps"] = [];
	const mainLoopEntries: MainLoopStepEntry[] = [];
	const stepTokenUsage: StepTokenUsage[] = [];
	const stepRuntimeMetrics: StepRuntimeMetrics[] = [];
	const stepArtifacts: RunAgentStepArtifact[] = [];
	const maxSteps = input.maxSteps ?? MAX_STEPS;
	const generateStep = input.generateStep ?? createDefaultGenerateStep();
	const executorContextPolicy = resolveExecutorContextPolicy(
		input.stageLLMs.runAgent,
		input.featureFlags.enableExecutorActionContextFieldsForOpenAI,
	);
	const openAIEncryptedResponsesEnabled =
		input.stageLLMs.runAgent.provider === "openai";
	const openAIProjectionStrategy = input.featureFlags.semanticProjectionHistory;
	const openAIExplicitPromptCachingEnabled =
		openAIProjectionStrategy === "current" &&
		supportsOpenAIExplicitPromptCaching(
			input.stageLLMs.runAgent.provider,
			input.stageLLMs.runAgent.model,
		);
	const openAIPromptCache = openAIExplicitPromptCachingEnabled
		? buildOpenAIPromptCacheRequest({
				model: input.stageLLMs.runAgent.model,
				shard: input.promptCacheShard ?? "core",
				featureFlags: input.featureFlags,
				executorContextPolicy,
				customTools: input.customTools,
			})
		: undefined;
	const dataExtractionPromptCache =
		input.stageLLMs.dataExtraction !== undefined &&
		supportsOpenAIExplicitPromptCaching(
			input.stageLLMs.dataExtraction.provider,
			input.stageLLMs.dataExtraction.model,
		)
			? buildOpenAIExplicitNoCacheRequest()
			: undefined;
	const verificationPromptCache =
		successVerifierLLMOptions !== undefined &&
		supportsOpenAIExplicitPromptCaching(
			successVerifierLLMOptions.provider,
			successVerifierLLMOptions.model,
		)
			? buildOpenAIExplicitNoCacheRequest()
			: undefined;
	let validatorFailureCount = 0;
	let pendingValidatorFeedback: ValidatorFeedback | undefined;
	let sessionStarted = false;
	try {
		await input.onBeforeSessionCreated?.(input.session);
		const sessionResult = await withAbort(
			abortSignal,
			async () => await createSession(deps, input.session),
		);
		sessionStarted = true;
		sessionResult.session.authTakeover = createSessionAuthTakeoverState({
			enabled: input.featureFlags.authTakeover,
			requestAuthDomainCandidates: input.requestAuthDomainCandidates,
			requestAuthIdentifierForDomain: input.requestAuthIdentifierForDomain,
			requestAuthPasswordForDomain: input.requestAuthPasswordForDomain,
			authProbeLLM: deps.defaultAuthProbeLLMOptions ?? input.stageLLMs.runAgent,
		});
		await input.onSessionCreated?.(sessionResult);

		const preprocess = await withAbort(
			abortSignal,
			async () =>
				await preprocessTask(deps, {
					port: input.session.port,
					userTask: input.task,
					url: input.session.url,
					stageLLMs: input.stageLLMs,
					recordModelInvocation: input.recordModelInvocation,
				}),
		);
		await input.onPreprocessedTask?.({ preprocess });
		const saveStepsContext = input.saveStepsContext ?? shouldSaveStepsContext();
		const artifactDirectories = resolveBrowserAgentArtifactDirectories(
			input.artifactDirectories,
		);
		const session = sessionResult.session;
		let finalResult: string | null = null;

		for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
			throwIfAborted(abortSignal);
			let modelOutputErrors: string[] | undefined;
			const stepAttemptUsages: TokenUsage[] = [];
			let stepResult:
				| {
						status: "continue";
				  }
				| {
						status: "user_takeover";
						reason: string;
						category?: UserTakeoverCategory;
				  }
				| {
						status: "done";
						result: string | null;
						successful: boolean;
						successVerification?: RunAgentResult["successVerification"];
				  } = { status: "continue" };

			for (let attempt = 1; attempt <= MAX_STEP_RETRIES; attempt++) {
				const stepTimings: StepPartTimingEntry[] = [];
				const stepStartedAt = Date.now();
				const snapshot = snapshotSession(session);
				const validatorFailureCountAtAttemptStart = validatorFailureCount;
				const pendingValidatorFeedbackAtAttemptStart = pendingValidatorFeedback;
				const historyProjectionContextsAtAttemptStart = stepsHistory.map(
					(entry) => ({
						hasProjection: Object.prototype.hasOwnProperty.call(
							entry.payload,
							"projection",
						),
						projection: entry.payload.projection,
						hasProjectionContextMode: Object.prototype.hasOwnProperty.call(
							entry.payload,
							"projectionContextMode",
						),
						projectionContextMode: entry.payload.projectionContextMode,
					}),
				);
				const lengths = {
					stepsHistory: stepsHistory.length,
					steps: steps.length,
					mainLoopEntries: mainLoopEntries.length,
					stepTokenUsage: stepTokenUsage.length,
					stepRuntimeMetrics: stepRuntimeMetrics.length,
					stepArtifacts: stepArtifacts.length,
				};
				try {
					await withAbort(
						abortSignal,
						async () => await deps.waitForAutomationPermission(),
					);
					const isMaxStepFinalization = stepNumber === maxSteps;
					const promptResult = await withAbort(
						abortSignal,
						async () =>
							await measureStepPart({
								timings: stepTimings,
								part: "create_prompt_for_step",
								run: async () =>
									await createPromptForStep(deps, {
										port: input.session.port,
										userTask: input.task,
										stepsHistory,
										llmOptions: input.stageLLMs.runAgent,
										autoSwitchToNewTab: input.autoSwitchToNewTab,
										stepNumber,
										finalizationInstruction: isMaxStepFinalization
											? MAX_STEP_FINALIZATION_INSTRUCTION
											: undefined,
										forceMemoryContent: isMaxStepFinalization,
										validatorFeedback: pendingValidatorFeedback,
										modelOutputErrors,
										openAIExplicitPromptCaching:
											openAIExplicitPromptCachingEnabled,
										executorContextPolicy,
										customTools: input.customTools,
									}),
							}),
					);
					if (isMaxStepFinalization) {
						console.log(
							`[runAgent] max steps reached at step ${stepNumber}; running return_results-only finalization`,
						);
					}
					if (input.includeStepArtifactsInResult) {
						stepArtifacts.push({
							stepNumber,
							projectionYaml: promptResult.artifacts.canonicalProjection,
							contextJson: serializeStepContextForDisk(
								promptResult.prompt.messages,
							),
						});
					}
					await measureStepPart({
						timings: stepTimings,
						part: "save_step_context_pre_llm",
						run: async () =>
							await saveStepContextIfNeeded({
								saveStepsContext,
								contextDir: artifactDirectories.contextDir,
								stepsDir: artifactDirectories.stepsDir,
								stepNumber,
								messages: promptResult.prompt.messages,
								pageProjection: promptResult.artifacts.canonicalProjection,
								browser: session.browser,
								memoryFile: session.memoryFile,
								extractDataMemoryFile: session.extractDataMemoryFile,
								memorySnapshotPhase: "pre-llm",
								preStepScreenshotDataUrl:
									promptResult.artifacts.preStepScreenshotDataUrl,
							}),
					});
					const generatedStep = await withAbort(
						abortSignal,
						async () =>
							await measureStepPart({
								timings: stepTimings,
								part: "llm_step_call",
								run: async () =>
									await generateStep({
										stepNumber,
										messages: promptResult.prompt.messages,
										llmOptions: input.stageLLMs.runAgent,
										promptPayload: promptResult.prompt.payload,
										stepsHistory,
										caller: isMaxStepFinalization
											? "runAgent:maxStepFinalization"
											: undefined,
										stepKind: isMaxStepFinalization
											? "max_step_finalization"
											: "executor_step",
										abortSignal,
										openAIEncryptedResponses: openAIEncryptedResponsesEnabled,
										openAIPromptCache,
									}),
							}),
					);
					const {
						data: rawStep,
						usage,
						reasoning_tokens,
						responseMessages,
						raw_response,
					} = generatedStep;
					usages.push(usage);
					stepAttemptUsages.push(usage);
					const processedRawStep = processModelStepOutput(
						rawStep,
						executorContextPolicy,
						raw_response,
						input.customTools,
					);
					await input.onStepGenerated?.({
						stepNumber,
						attempt,
						step: rawStep,
						usage,
						reasoningTokens: reasoning_tokens,
						disposition: processedRawStep.actionContractStatus,
						diagnostics: [...processedRawStep.normalizationDiagnostics],
					});
					if (processedRawStep.actionContractStatus === "rejected") {
						modelOutputErrors = processedRawStep.normalizationDiagnostics.map(
							(diagnostic) =>
								`${diagnostic}. The entire action list was rejected; no actions, checklist updates, or plan updates were applied.`,
						);
						throw new ModelStepActionContractError(
							processedRawStep.normalizationDiagnostics,
						);
					}
					modelOutputErrors = undefined;
					const parsedRawStep = processedRawStep.step;
					const rawAssistantContent = processedRawStep.assistant;
					const acceptedResponseMessages = Array.isArray(responseMessages)
						? responseMessages
						: [{ role: "assistant" as const, content: rawAssistantContent }];
					const accountedStepUsage = combineStepAttemptUsage(stepAttemptUsages);
					logStepActionContext(parsedRawStep, executorContextPolicy);
					const maxStepHasOnlyReturnResults =
						parsedRawStep.actions.length === 1 &&
						parsedRawStep.actions[0]?.type === "return_results";
					if (isMaxStepFinalization && !maxStepHasOnlyReturnResults) {
						const mainLoopStepIndex = mainLoopEntries.length + 1;
						mainLoopEntries.push({
							step: mainLoopStepIndex,
							step_kind: "max_step_finalization",
							messages: serializeMessagesForDisk([
								...promptResult.prompt.messages,
								...acceptedResponseMessages,
							]),
						});
						stepTokenUsage.push(
							buildStepTokenUsage(mainLoopStepIndex, accountedStepUsage),
						);
						logStepModelResponse({
							stepNumber: mainLoopStepIndex,
							step: parsedRawStep,
							totalTokens: accountedStepUsage.total_tokens,
							executorContextPolicy,
						});
						steps.push({
							step: stepNumber,
							model: parsedRawStep,
							usage: accountedStepUsage,
						});
						await input.onStepCompleted?.({
							stepNumber,
							step: parsedRawStep,
							usage: accountedStepUsage,
							promptContext: {
								current_url:
									typeof promptResult.prompt.payload.currentURL === "string"
										? promptResult.prompt.payload.currentURL
										: undefined,
								current_tab:
									typeof promptResult.prompt.payload.currentTab === "number"
										? promptResult.prompt.payload.currentTab
										: undefined,
								open_tabs: Array.isArray(promptResult.prompt.payload.openTabs)
									? promptResult.prompt.payload.openTabs.filter(
											(item): item is string => typeof item === "string",
										)
									: undefined,
								downloaded_files: Array.isArray(
									promptResult.prompt.payload.downloadedFiles,
								)
									? promptResult.prompt.payload.downloadedFiles.filter(
											(item): item is string => typeof item === "string",
										)
									: undefined,
							},
						});
						console.warn(
							"[runAgent] max-step finalization did not return exactly one return_results tool call; treating run as incomplete",
						);
						stepResult = { status: "continue" };
						recordStepRuntimeMetrics({
							stepRuntimeMetrics,
							stepNumber: mainLoopStepIndex,
							timings: stepTimings,
							totalDurationMs: Date.now() - stepStartedAt,
							usage: accountedStepUsage,
						});
						break;
					}

					const processResult = await withAbort(
						abortSignal,
						async () =>
							await measureStepPart({
								timings: stepTimings,
								part: "process_model_output_and_browse",
								run: async () =>
									await processModelOutputAndBrowse(deps, input.session.port, {
										mode: "process_model_step_output",
										rawStepOutput: rawStep,
										rawAssistantOutputText: rawAssistantContent,
										responseMessages: acceptedResponseMessages,
										executorContextPolicy,
										promptPayload: promptResult.prompt.payload,
										stepsHistory,
										stepNumber,
										dataExtractionLLMOptions: input.stageLLMs.dataExtraction,
										dataExtractionPromptCache,
										verificationPromptCache,
										recordModelInvocation: input.recordModelInvocation,
										sessionChecklist: session.activeChecklist,
										verificationPurpose:
											validatorLifecycle.mode === "retry"
												? "completion_verifier"
												: "terminal_judge",
										validatorContext: validatorLifecycle.context ?? "full",
										skipSuccessVerification:
											validatorLifecycle.mode === "disabled",
										allowFatalActionErrors: true,
										autoSwitchToNewTab: input.autoSwitchToNewTab,
										customTools: input.customTools,
									}),
							}),
					);
					pendingValidatorFeedback = undefined;
					const mainLoopStepIndex = mainLoopEntries.length + 1;
					mainLoopEntries.push({
						step: mainLoopStepIndex,
						step_kind: isMaxStepFinalization
							? "max_step_finalization"
							: "executor_step",
						messages: serializeMessagesForDisk([
							...promptResult.prompt.messages,
							...acceptedResponseMessages,
						]),
					});
					stepTokenUsage.push(
						buildStepTokenUsage(mainLoopStepIndex, accountedStepUsage),
					);
					logStepModelResponse({
						stepNumber: mainLoopStepIndex,
						step: processResult.step,
						totalTokens: accountedStepUsage.total_tokens,
						executorContextPolicy,
					});

					const authTakeoverAttempts =
						processResult.browse?.execution.auth_takeover_attempts ?? [];
					for (const authAttempt of authTakeoverAttempts) {
						const authStepIndex = mainLoopEntries.length + 1;
						mainLoopEntries.push({
							step: authStepIndex,
							step_kind: "auth_takeover_attempt",
							messages: serializeAuthAttemptMessages(authAttempt.messages),
						});
						const authUsage = authAttempt.token_usage;
						stepTokenUsage.push(buildStepTokenUsage(authStepIndex, authUsage));
						const authGenerationMs = authUsage?.generation_time_ms ?? 0;
						if (shouldLogTimingDuration(authGenerationMs)) {
							console.log(
								`  [step ${authStepIndex} timing-split] state_extraction_ms=0 | llm_decision_ms=${authGenerationMs} | tool_execution_ms=0`,
							);
						}
					}

					steps.push({
						step: stepNumber,
						model: processResult.step,
						usage: accountedStepUsage,
						browse: processResult.browse,
					});
					await input.onStepCompleted?.({
						stepNumber,
						step: processResult.step,
						usage: accountedStepUsage,
						browse: processResult.browse,
						promptContext: {
							current_url:
								typeof promptResult.prompt.payload.currentURL === "string"
									? promptResult.prompt.payload.currentURL
									: undefined,
							current_tab:
								typeof promptResult.prompt.payload.currentTab === "number"
									? promptResult.prompt.payload.currentTab
									: undefined,
							open_tabs: Array.isArray(promptResult.prompt.payload.openTabs)
								? promptResult.prompt.payload.openTabs.filter(
										(item): item is string => typeof item === "string",
									)
								: undefined,
							downloaded_files: Array.isArray(
								promptResult.prompt.payload.downloadedFiles,
							)
								? promptResult.prompt.payload.downloadedFiles.filter(
										(item): item is string => typeof item === "string",
									)
								: undefined,
						},
					});
					await measureStepPart({
						timings: stepTimings,
						part: "save_step_context_post_actions",
						run: async () =>
							await saveStepContextIfNeeded({
								saveStepsContext,
								contextDir: artifactDirectories.contextDir,
								stepsDir: artifactDirectories.stepsDir,
								stepNumber,
								messages: promptResult.prompt.messages,
								pageProjection: promptResult.artifacts.canonicalProjection,
								browser: session.browser,
								memoryFile: session.memoryFile,
								extractDataMemoryFile: session.extractDataMemoryFile,
								memorySnapshotPhase: "post-actions",
								writeCoreFiles: false,
							}),
					});

					const userTakeover = processResult.browse?.execution.user_takeover;
					if (userTakeover) {
						stepResult = {
							status: "user_takeover",
							reason: userTakeover.reason,
							category: userTakeover.category,
						};
					} else if (processResult.step.done) {
						finalResult = processResult.step.result ?? null;
						const rejectedByValidator =
							processResult.successVerification?.success === false;
						if (rejectedByValidator) {
							validatorFailureCount += 1;
						}
						const continueAfterRejection =
							rejectedByValidator &&
							validatorLifecycle.mode === "retry" &&
							validatorFailureCount < validatorLifecycle.maxFailures &&
							stepNumber < maxSteps;
						if (continueAfterRejection && processResult.successVerification) {
							if (
								deps.featureFlags.taskChecklist &&
								processResult.successVerification.regenerateChecklist
							) {
								await regenerateChecklistAfterVerification({
									deps,
									input,
									session,
									verification: processResult.successVerification,
									stepNumber,
								});
							}
							const checklistChanges = deps.featureFlags.taskChecklist
								? applyVerifierChecklistChanges({
										items: session.activeChecklist,
										reopenIds: processResult.successVerification
											.regenerateChecklist
											? undefined
											: processResult.successVerification
													.reopenChecklistItemIds,
										addRequirements:
											processResult.successVerification.addChecklistItems,
									})
								: { reopenedIds: [], addedIds: [] };
							pendingValidatorFeedback = buildValidatorFeedback({
								failure: validatorFailureCount,
								maxFailures: validatorLifecycle.maxFailures,
								verification: processResult.successVerification,
								reopenChecklistItemIds: checklistChanges.reopenedIds,
								addedChecklistItemIds: checklistChanges.addedIds,
							});
							console.warn(
								`[runAgent] validator rejected result (${validatorFailureCount}/${validatorLifecycle.maxFailures}); continuing with feedback`,
							);
							stepResult = { status: "continue" };
						} else {
							stepResult = {
								status: "done",
								result: finalResult,
								successful:
									validatorLifecycle.mode === "disabled"
										? true
										: processResult.successful,
								successVerification: processResult.successVerification,
							};
						}
					} else {
						const promptPayloadUrl =
							typeof promptResult.prompt.payload.currentURL === "string"
								? promptResult.prompt.payload.currentURL
								: "";
						const actionSignature = buildActionSignatureWithUrl(
							processResult.step,
							promptPayloadUrl,
						);
						if (session.lastActionSignatureWithUrl === actionSignature) {
							session.sameActionSignatureStreak += 1;
						} else {
							session.sameActionSignatureStreak = 1;
						}
						session.lastActionSignatureWithUrl = actionSignature;

						const progressSignature = buildProgressSignature({
							url: processResult.browse?.context.current_url ?? "",
							projection: processResult.browse?.context.projection ?? "",
							downloadedFiles:
								processResult.browse?.context.downloaded_files ?? [],
						});
						if (session.lastProgressSignature === progressSignature) {
							session.noProgressStreak += 1;
						} else {
							session.noProgressStreak = 1;
						}
						session.lastProgressSignature = progressSignature;
						emitStagnationWarning(session, stepNumber);
						await withAbort(
							abortSignal,
							async () =>
								await measureStepPart({
									timings: stepTimings,
									part: "wait_for_settle",
									run: async () => {
										if (
											input.featureFlags.optimizeExecutorStepDelays &&
											canSkipExecutorStepDelay(processResult.step.actions)
										) {
											return;
										}
										await sleep(DEFAULT_EXECUTOR_STEP_DELAY_MS);
									},
								}),
						);
						stepResult = { status: "continue" };
					}
					recordStepRuntimeMetrics({
						stepRuntimeMetrics,
						stepNumber: mainLoopStepIndex,
						timings: stepTimings,
						totalDurationMs: Date.now() - stepStartedAt,
						usage: accountedStepUsage,
					});
					break;
				} catch (error) {
					if (isAbortError(error) || abortSignal?.aborted) {
						throw isAbortError(error)
							? error
							: createRunAgentAbortError(abortSignal);
					}
					await restoreSession(session, snapshot);
					validatorFailureCount = validatorFailureCountAtAttemptStart;
					pendingValidatorFeedback = pendingValidatorFeedbackAtAttemptStart;
					for (
						let index = 0;
						index < historyProjectionContextsAtAttemptStart.length;
						index++
					) {
						const entry = stepsHistory[index];
						const projectionContext =
							historyProjectionContextsAtAttemptStart[index];
						if (!entry || !projectionContext) continue;
						if (projectionContext.hasProjection) {
							entry.payload.projection = projectionContext.projection;
						} else {
							delete entry.payload.projection;
						}
						if (projectionContext.hasProjectionContextMode) {
							entry.payload.projectionContextMode =
								projectionContext.projectionContextMode;
						} else {
							delete entry.payload.projectionContextMode;
						}
					}
					stepsHistory.length = lengths.stepsHistory;
					steps.length = lengths.steps;
					mainLoopEntries.length = lengths.mainLoopEntries;
					stepTokenUsage.length = lengths.stepTokenUsage;
					stepRuntimeMetrics.length = lengths.stepRuntimeMetrics;
					stepArtifacts.length = lengths.stepArtifacts;
					if (error instanceof ModelStepActionContractError) {
						console.warn(
							`[step ${stepNumber}] model action contract rejected (attempt ${attempt}/${MAX_STEP_RETRIES}): ${error.diagnostics.join("; ")}`,
						);
						if (attempt === MAX_STEP_RETRIES) {
							throw error;
						}
						continue;
					}
					console.error(
						`[step ${stepNumber}] execution failed (attempt ${attempt}/${MAX_STEP_RETRIES}): ${
							error instanceof Error
								? (error.stack ?? error.message)
								: String(error)
						}`,
					);
					if (attempt === MAX_STEP_RETRIES) {
						throw error;
					}
					await sleep(500 * attempt);
				}
			}
			if (stepResult.status === "user_takeover") {
				return {
					preprocess,
					completed: false,
					successful: false,
					result: null,
					steps,
					stepsHistory,
					mainLoopEntries,
					stepTokenUsage,
					stepRuntimeMetrics,
					...(input.includeStepArtifactsInResult ? { stepArtifacts } : {}),
					tokenTotals: sumTokenUsage(usages),
					userActionRequired: {
						kind: "browser_user_takeover",
						reason: stepResult.reason,
						category: stepResult.category,
					},
				};
			}

			if (stepResult.status === "done") {
				return {
					preprocess,
					completed: true,
					successful: stepResult.successful,
					result: stepResult.result,
					steps,
					stepsHistory,
					mainLoopEntries,
					stepTokenUsage,
					stepRuntimeMetrics,
					...(input.includeStepArtifactsInResult ? { stepArtifacts } : {}),
					tokenTotals: sumTokenUsage(usages),
					successVerification: stepResult.successVerification,
				};
			}
		}

		return {
			preprocess,
			completed: false,
			successful: false,
			result: finalResult,
			steps,
			stepsHistory,
			mainLoopEntries,
			stepTokenUsage,
			stepRuntimeMetrics,
			...(input.includeStepArtifactsInResult ? { stepArtifacts } : {}),
			tokenTotals: sumTokenUsage(usages),
		};
	} finally {
		if (sessionStarted && !input.keepSessionOpen) {
			await closeSession(deps, input.session.port);
		}
	}
}
