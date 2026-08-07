import type { Browser, Tab } from "../browser/types.js";
import type { BrowserAgentArtifactDirectories } from "../browser/constants.js";
import type { ExecutorPromptOptions } from "../agents/prompts.js";
import type { ConfigFeatureFlags } from "../config-feature-flags.js";
import type {
	Action,
	AuthTakeoverAttemptEvent,
	ChatJSONResult,
	ExtractionStepUsage,
	ExecuteActionsResult,
	LLMOptions,
	MainLoopStepEntry,
	Message,
	Provider,
	RecapStageUsage,
	StageModelInvocationTrace,
	StepResult as ModelStepResult,
	StepTokenUsage,
	TokenUsage,
	OpenAIEncryptedContinuationInput,
} from "../agents/types.js";
import type {
	RequestAuthDomainCandidates,
	RequestAuthIdentifierForDomain,
	RequestAuthPasswordForDomain,
} from "../auth/types.js";
import type { extractDataResultsFromSnapshot } from "../agents/data-extraction.js";
import {
	buildStepMessages,
	buildStepPayload,
} from "../agents/executor-utils/step-execution.js";
import { getExecutorSystem } from "../agents/prompts.js";
import { executeActions } from "../agents/executor-utils/action-execution.js";
import {
	capturePreStepScreenshotDataUrl,
	formatTabTitle,
	getNewlyOpenedTabs,
	resolveCurrentTabIndex,
} from "../agents/executor-utils/step-context.js";
import type { SessionRegistry, BrowserSession } from "./session-registry.js";
import type { BrowserRemoteInput } from "../browser/types.js";
import type { SemanticProjectionOptions } from "../browser/semantic-projection.js";
import type { UserTakeoverCategory } from "../user-action-types.js";
import type { switchTab } from "../browser/interaction/tabs.js";
import type { waitForAllOpenTabsToSettle } from "../browser/interaction/wait-for-open-tabs-settle.js";
import type { TaskExecutionOverridesIndex } from "./task-execution-overrides.js";

export interface PreprocessStageLLMs {
	findTargetURL: LLMOptions;
	createChecklist: LLMOptions;
}

export interface RunTaskStageLLMs extends PreprocessStageLLMs {
	runAgent: LLMOptions;
	dataExtraction: LLMOptions;
	verifySuccess?: LLMOptions;
}

export interface ValidatorLifecycleOptions {
	mode: "terminal" | "retry";
	maxFailures: number;
	context?: "full" | "compact";
}

export interface ValidatorFeedback {
	failure: number;
	maxFailures: number;
	summary: string;
	reasons: string[];
	instruction: string;
	reopenChecklistItemIds?: string[];
	addedChecklistItemIds?: string[];
}

export interface TokenUsageTotals {
	input_tokens: number;
	cached_input_tokens: number;
	reasoning_tokens: number;
	non_reasoning_output_tokens: number;
	output_tokens: number;
	total_tokens: number;
	generation_time_ms: number;
}

export interface TokenUsageArtifactInvocation {
	sequence: number;
	kind: "stage" | "executor_step";
	phase: "preprocess" | "executor" | "verification" | "other";
	stage: string;
	provider?: Provider;
	model?: string;
	step?: number;
	stepKind?: MainLoopStepEntry["step_kind"];
	modelAttempt?: number;
	usage: TokenUsage | null;
}

export interface TokenUsageArtifactAttempt {
	runIndex: number;
	retryAttempt: number;
	completed: boolean;
	successful: boolean;
	invocations: TokenUsageArtifactInvocation[];
	totals: TokenUsageTotals;
}

export interface TaskTokenUsageArtifact {
	schemaVersion: 1;
	taskIndex: number;
	task: string;
	attempts: TokenUsageArtifactAttempt[];
	totals: TokenUsageTotals;
}

export interface CoreDeps {
	featureFlags: ConfigFeatureFlags;
	userActionBehavior: "block" | "return" | "callback";
	onUserActionRequired?: (input: {
		kind: "browser_user_takeover";
		reason: string;
		category?: UserTakeoverCategory;
	}) => Promise<void>;
	requestAgentTakeover?: (
		input: BrowserAgentTakeoverRequest,
	) => Promise<BrowserAgentTakeoverResult>;
	registry: SessionRegistry;
	isPortInUse: (port: number) => Promise<boolean>;
	launchBrowser: (
		port: number,
		headless: boolean,
		proxy?: {
			host: string;
			port: number;
		},
		downloadDir?: string,
		userDataDir?: string,
		windowMode?: "visible" | "hidden",
		executablePath?: string,
	) => Promise<Browser>;
	closeBrowser: (browser: Browser) => Promise<void>;
	navigateBrowser: (browser: Browser, url: string) => Promise<void>;
	downloadFileFromUrl: (
		browser: Browser,
		fileUrl: string,
		options?: { title?: string; contentType?: string },
	) => Promise<string>;
	getCurrentURL: (browser: Browser) => Promise<string>;
	getPageProjection: (
		browser: Browser,
		options?: SemanticProjectionOptions,
	) => Promise<string>;
	listTabs: (browser: Browser) => Promise<Tab[]>;
	extractValidRefs: (projection: string) => string[];
	findTargetURL: (
		task: string,
		options: LLMOptions,
		traceOptions?: {
			onTrace?: (trace: StageModelInvocationTrace) => void;
			meta?: Record<string, unknown>;
		},
	) => Promise<string>;
	createChecklist: typeof import("../agents/checklist.js").createChecklist;
	buildStepPayload: typeof buildStepPayload;
	buildStepMessages: typeof buildStepMessages;
	getExecutorSystem: (options?: ExecutorPromptOptions) => string;
	normalizeActionList: (actions: unknown) => Action[];
	normalizeActionListWithDiagnostics: (
		actions: unknown,
	) => import("../agents/executor-utils/action-normalization.js").NormalizeActionListResult;
	executeActions: typeof executeActions;
	extractDataResultsFromSnapshot: typeof extractDataResultsFromSnapshot;
	switchTab: typeof switchTab;
	waitForAllOpenTabsToSettle: typeof waitForAllOpenTabsToSettle;
	resolveCurrentTabIndex: typeof resolveCurrentTabIndex;
	getNewlyOpenedTabs: typeof getNewlyOpenedTabs;
	capturePreStepScreenshotDataUrl: typeof capturePreStepScreenshotDataUrl;
	estimateTokenCount: (text: string) => number;
	formatTabTitle: typeof formatTabTitle;
	createSessionMemoryFile: (port: number) => string;
	createSessionExtractDataMemoryFile: (port: number) => string;
	waitForAutomationPermission: () => Promise<void>;
	dispatchRemoteInput: (
		browser: Browser,
		input: BrowserRemoteInput,
	) => Promise<void>;
	verifyTaskSuccess?: (
		input: import("../agents/success-verifier.js").VerifyTaskSuccessInput,
	) => Promise<import("../agents/types.js").SuccessVerificationResult>;
	defaultAuthProbeLLMOptions?: LLMOptions;
	defaultSuccessVerifierLLMOptions?: LLMOptions;
}

export interface CreateSessionInput {
	port: number;
	headless: boolean;
	windowMode?: "visible" | "hidden";
	url?: string;
	downloadDir?: string;
	downloadRootDir?: string;
	fileWorkspaceRoot?: string;
	pinnedMemoryContent?: string;
	preparedPasteFiles?: string[];
	userDataDir?: string;
	executablePath?: string;
	proxy?: {
		host: string;
		port: number;
	};
	forceRestart?: boolean;
}

export interface BrowserAgentTakeoverRequest {
	stepNumber?: number;
	request: string;
	currentUrl?: string;
	openTabs: string[];
	workspaceFiles: string[];
	downloadedFiles: string[];
	maxChars?: number;
}

export interface BrowserAgentTakeoverResult {
	status: "completed" | "not_applicable" | "failed";
	memoryContent?: string;
	summary?: string;
	sourceFiles?: string[];
	error?: string;
}

export interface CreateSessionResult {
	session: BrowserSession;
	currentUrl: string;
}

export interface PreprocessTaskInput {
	port: number;
	userTask: string;
	url?: string;
	stageLLMs: PreprocessStageLLMs;
	log?: (message: string) => void;
	recordModelInvocation?: (trace: StageModelInvocationTrace) => void;
}

export interface PreprocessTaskResult {
	target_url: string;
	final_url: string;
	checklist: import("../agents/types.js").ChecklistItem[];
	context: {
		current_url: string;
		open_tabs: string[];
		current_tab: number;
	};
}

export interface StepHistoryEntry {
	payload: Record<string, unknown>;
	/** Accepted model output, preserved independently from normalized execution actions. */
	assistant: unknown;
	reasoningTokens?: string;
}

export interface CreatePromptForStepInput {
	port: number;
	userTask: string;
	stepsHistory: StepHistoryEntry[];
	stepNumber?: number;
	llmOptions?: LLMOptions;
	autoSwitchToNewTab?: boolean;
	finalizationInstruction?: string;
	forceMemoryContent?: boolean;
	validatorFeedback?: ValidatorFeedback;
	modelOutputErrors?: string[];
	openAIEncryptedResponses?: boolean;
}

export interface CreatePromptForStepResult {
	prompt: {
		messages: unknown[];
		payload: Record<string, unknown>;
	};
	artifacts: {
		preStepScreenshotDataUrl?: string;
		canonicalProjection: string;
	};
	context: {
		current_url: string;
		open_tabs: string[];
		current_tab: number;
		valid_refs_count: number;
		latest_user_prompt_token_count: number;
		prompt_budget_reductions: string[];
	};
}

export interface BrowseInput {
	port: number;
	generatedActions: unknown;
	generatedActionsAreNormalized?: boolean;
	userTask?: string;
	pageProjection?: string;
	dataExtractionLLMOptions?: LLMOptions;
	recordModelInvocation?: (trace: StageModelInvocationTrace) => void;
	stepNumber?: number;
	allowFatalActionErrors?: boolean;
	autoSwitchToNewTab?: boolean;
	promptDownloadedFiles?: string[];
	promptWorkspaceFiles?: string[];
	memoryContentAvailable?: boolean;
}

export interface BrowseResult {
	execution: {
		pending_memory_read: boolean;
		returned_result?: string;
		interaction_errors: string[];
		auth_takeover_attempts?: AuthTakeoverAttemptEvent[];
		user_takeover?: {
			reason: string;
			category?: UserTakeoverCategory;
		};
	};
	context: {
		current_url: string;
		open_tabs: string[];
		current_tab: number;
		downloaded_files: string[];
		projection: string;
		valid_refs: string[];
	};
}

export interface ProcessModelStepOutputInput {
	rawStepOutput: unknown;
	/** Exact accepted assistant text when available from the provider. */
	rawAssistantOutputText?: string;
	promptPayload: Record<string, unknown>;
	stepsHistory: StepHistoryEntry[];
	executorProvider?: Provider;
	openAIEncryptedResponses?: boolean;
	reasoningTokens?: string;
	stepNumber?: number;
	dataExtractionLLMOptions?: LLMOptions;
	recordModelInvocation?: (trace: StageModelInvocationTrace) => void;
	sessionChecklist?: import("../agents/types.js").ChecklistItem[];
	verificationPurpose?: "terminal_judge" | "completion_verifier";
	validatorContext?: "full" | "compact";
	allowModelResultCompletion?: boolean;
	allowFatalActionErrors?: boolean;
	autoSwitchToNewTab?: boolean;
}

export interface ProcessModelStepOutputResult {
	step: ModelStepResult;
	history_entry: StepHistoryEntry;
	successful: boolean;
	successVerification?: import("../agents/types.js").SuccessVerificationResult;
}

export type StepInput =
	| ({ mode: "create_prompt_for_step" } & CreatePromptForStepInput)
	| ({ mode: "browse" } & BrowseInput)
	| ({ mode: "process_model_step_output" } & ProcessModelStepOutputInput);

export type StepResult =
	| ({ mode: "create_prompt_for_step" } & CreatePromptForStepResult)
	| ({ mode: "browse" } & BrowseResult)
	| ({ mode: "process_model_step_output" } & ProcessModelStepOutputResult);

export type StepMode = StepInput["mode"];

export type StepInputByMode<TMode extends StepMode> = Extract<
	StepInput,
	{ mode: TMode }
>;

export type StepResultByMode<TMode extends StepMode> = Extract<
	StepResult,
	{ mode: TMode }
>;

export interface RunTaskBrowserLaunchOptions {
	port?: number;
	headless: boolean;
	proxy?: {
		host: string;
		port: number;
	};
	url?: string;
	downloadDir?: string;
	fileWorkspaceRoot?: string;
	userDataDir?: string;
	executablePath?: string;
	workerId: number;
}

export interface RunTaskPersistenceCallbacks {
	appendJsonlEntry: (entry: unknown, runIndex: number) => void;
	saveTokenUsageAttempt?: (attempt: TokenUsageArtifactAttempt) => void;
	reportSingleRunExecution?: (
		result: string,
		steps: number,
		tokenUsage: StepTokenUsage[],
		successful: boolean,
		successVerification?: import("../agents/types.js").SuccessVerificationResult,
		stepRuntimeMetrics?: StepRuntimeMetrics[],
		extractionStepUsage?: ExtractionStepUsage[],
		stageUsage?: RecapStageUsage[],
	) => void;
}

export interface RunTaskInput {
	task: string;
	taskNumber: number;
	totalTasks: number;
	taskRuns: number;
	taskRunRetryCount: number;
	taskUntilSuccessMaxAttempts?: number;
	maxSteps: number;
	validatorLifecycle?: ValidatorLifecycleOptions;
	stageLLMs: RunTaskStageLLMs;
	requestAuthDomainCandidates?: RequestAuthDomainCandidates;
	requestAuthIdentifierForDomain?: RequestAuthIdentifierForDomain;
	requestAuthPasswordForDomain?: RequestAuthPasswordForDomain;
	onUserActionRequired?: (input: {
		kind: "browser_user_takeover";
		reason: string;
		category?: UserTakeoverCategory;
	}) => Promise<void>;
	browserLaunch: RunTaskBrowserLaunchOptions;
	persistence: RunTaskPersistenceCallbacks;
	taskExecutionOverrides?: TaskExecutionOverridesIndex;
}

export interface RunFailureRecord {
	runIndex: number;
	errors: string[];
	kind: "runtime_exception" | "terminal_run_failure";
}

export interface RunTaskRunResult {
	runIndex: number;
	result: string | null;
	completed: boolean;
	successful: boolean;
	validator: {
		ran: boolean;
		success: boolean;
		summary: string;
	};
}

export interface RunTaskResult {
	failedRuns: RunFailureRecord[];
	runtimeFailedRuns: RunFailureRecord[];
	terminalFailedRuns: RunFailureRecord[];
	runs: RunTaskRunResult[];
}

export interface RunAgentGenerateStepInput {
	stepNumber: number;
	messages: Message[];
	llmOptions: LLMOptions;
	promptPayload: Record<string, unknown>;
	stepsHistory: StepHistoryEntry[];
	caller?: string;
	stepKind?: "executor_step" | "max_step_finalization";
	abortSignal?: AbortSignal;
	providerContinuation?: OpenAIEncryptedContinuationInput;
}

export type RunAgentGenerateStep = (
	input: RunAgentGenerateStepInput,
) => Promise<ChatJSONResult<ModelStepResult>>;

export interface RunAgentInput {
	session: CreateSessionInput;
	task: string;
	stageLLMs: RunTaskStageLLMs;
	featureFlags: ConfigFeatureFlags;
	autoSwitchToNewTab?: boolean;
	requestAuthDomainCandidates?: RequestAuthDomainCandidates;
	requestAuthIdentifierForDomain?: RequestAuthIdentifierForDomain;
	requestAuthPasswordForDomain?: RequestAuthPasswordForDomain;
	userActionBehavior?: "block" | "return" | "callback";
	abortSignal?: AbortSignal;
	recordModelInvocation?: (trace: StageModelInvocationTrace) => void;
	onUserActionRequired?: (input: {
		kind: "browser_user_takeover";
		reason: string;
		category?: UserTakeoverCategory;
	}) => Promise<void>;
	requestAgentTakeover?: (
		input: BrowserAgentTakeoverRequest,
	) => Promise<BrowserAgentTakeoverResult>;
	onRunStarted?: (input: {
		task: string;
		session: CreateSessionInput;
	}) => void | Promise<void>;
	onBeforeSessionCreated?: (input: CreateSessionInput) => void | Promise<void>;
	onSessionCreated?: (input: CreateSessionResult) => void | Promise<void>;
	onPreprocessedTask?: (input: {
		preprocess: PreprocessTaskResult;
	}) => void | Promise<void>;
	onStepGenerated?: (input: {
		stepNumber: number;
		attempt: number;
		step: ModelStepResult;
		usage: TokenUsage;
		reasoningTokens: string;
		disposition: "accepted" | "rejected";
		diagnostics: string[];
	}) => void | Promise<void>;
	onStepCompleted?: (input: {
		stepNumber: number;
		step: ModelStepResult;
		usage: TokenUsage;
		browse?: BrowseResult;
		promptContext?: {
			current_url?: string;
			current_tab?: number;
			open_tabs?: string[];
			downloaded_files?: string[];
		};
	}) => void | Promise<void>;
	maxSteps?: number;
	validatorLifecycle?: ValidatorLifecycleOptions;
	keepSessionOpen?: boolean;
	saveStepsContext?: boolean;
	artifactDirectories?: Partial<BrowserAgentArtifactDirectories>;
	includeStepArtifactsInResult?: boolean;
	generateStep?: RunAgentGenerateStep;
}

export interface RunAgentStepTrace {
	step: number;
	model: ModelStepResult;
	usage: TokenUsage;
	browse?: BrowseResult;
}

export interface RunAgentTokenTotals {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	total_tokens: number;
}

export interface RunAgentStepArtifact {
	stepNumber: number;
	projectionYaml: string;
	contextJson: Array<{
		role: string;
		content: unknown;
		reasoning_tokens?: string;
	}>;
}

export interface StepRuntimeMetrics {
	stepNumber: number;
	totalDurationMs: number;
	tokenGenerationMs: number;
	browserInteractionMs: number;
}

export interface RunAgentResult {
	preprocess: PreprocessTaskResult;
	completed: boolean;
	successful: boolean;
	result: string | null;
	steps: RunAgentStepTrace[];
	stepsHistory: StepHistoryEntry[];
	mainLoopEntries: MainLoopStepEntry[];
	stepTokenUsage: StepTokenUsage[];
	stepRuntimeMetrics: StepRuntimeMetrics[];
	stepArtifacts?: RunAgentStepArtifact[];
	tokenTotals: RunAgentTokenTotals;
	successVerification?: import("../agents/types.js").SuccessVerificationResult;
	userActionRequired?: {
		kind: "browser_user_takeover";
		reason: string;
		category?: UserTakeoverCategory;
	};
}

export interface TrainingRolloutGenerateStepResult extends ChatJSONResult<ModelStepResult> {
	rawModelOutputText: string;
	promptTokenIds?: number[];
	completionTokenIds?: number[];
	studentLogprobs?: number[];
	teacherPromptMessages?: unknown[];
	providerMetadata?: unknown;
}

export interface TrainingRolloutStep {
	stepNumber: number;
	stepKind: "executor_step" | "max_step_finalization";
	promptMessages: Message[];
	promptPayload: Record<string, unknown>;
	rawModelOutputText: string;
	generatedStep: ModelStepResult;
	normalizedStep: ModelStepResult;
	reasoningTokens: string;
	tokenUsage: TokenUsage;
	promptTokenIds: number[];
	completionTokenIds: number[];
	studentLogprobs: number[];
	teacherPromptMessages?: unknown[];
	providerMetadata?: unknown;
	browse?: BrowseResult;
	promptContext?: {
		current_url?: string;
		current_tab?: number;
		open_tabs?: string[];
		downloaded_files?: string[];
	};
	terminal?: {
		completed: boolean;
		successful: boolean;
		successVerification?: import("../agents/types.js").SuccessVerificationResult;
		userActionRequired?: RunAgentResult["userActionRequired"];
	};
}

export interface RunTrainingRolloutInput extends Omit<
	RunAgentInput,
	"generateStep"
> {
	generateStep: (
		input: RunAgentGenerateStepInput,
	) => Promise<TrainingRolloutGenerateStepResult>;
}

export interface RunTrainingRolloutResult {
	run: RunAgentResult;
	steps: TrainingRolloutStep[];
}
