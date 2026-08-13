import type { ModelMessage } from "ai";
import type { UserTakeoverCategory } from "../user-action-types.js";
import type {
	RequestAuthDomainCandidates,
	RequestAuthIdentifierForDomain,
	RequestAuthPasswordForDomain,
} from "../auth/types.js";
import type { Provider, ReasoningEffort } from "../llm-capabilities.js";

// LLM types
export {
	SUPPORTED_PROVIDERS,
	type Provider,
	type ReasoningEffort,
} from "../llm-capabilities.js";

export interface Message {
	role: "system" | "user" | "assistant";
	content: string | ContentPart[];
	providerOptions?: MessageProviderOptions;
	reasoning_tokens?: string;
}

export type MessageProviderOptions = Record<string, Record<string, unknown>>;

export type ContentPart =
	| {
			type: "text";
			text: string;
			providerOptions?: MessageProviderOptions;
	  }
	| {
			type: "image_url";
			image_url: { url: string; detail?: "low" | "high" | "auto" };
			providerOptions?: MessageProviderOptions;
	  };

export interface LLMOptions {
	provider: Provider;
	model: string;
	apiKey?: string;
	reasoningEffort: ReasoningEffort;
	maxModelLen?: number;
	reserveOutputTokens?: number;
	endpointUrl?: string;
	openrouterProvider?: string;
}

/** Model-derived executor context behavior, resolved once for each agent run. */
export interface ExecutorContextPolicy {
	includeReasoningTokensInPreviousSteps: boolean;
	executorActionContextFields: boolean;
}

export interface TokenUsage {
	input_tokens: number;
	cached_input_tokens?: number;
	cache_write_tokens?: number;
	reasoning_tokens?: number;
	non_reasoning_output_tokens?: number;
	output_tokens: number;
	total_tokens: number;
	time_to_first_token_ms?: number;
	generation_time_ms?: number;
}

interface OpenAIEncryptedContinuationBase {
	provider: "openai";
}

export interface OpenAIPromptCacheRequest {
	/** Omit the key when explicit mode is used only to disable implicit caching. */
	promptCacheKey?: string;
	promptCacheOptions: {
		mode: "explicit";
		ttl: "30m";
	};
}

export interface OpenAIEncryptedReasoningState {
	messages: ModelMessage[];
	reasoningTokenCount: number;
}

export type OpenAIEncryptedContinuationInput =
	| (OpenAIEncryptedContinuationBase & {
			strategy: "cumulative";
			messages: ModelMessage[];
			inputMode: "full" | "incremental";
			/** Index of the first message that was not represented by the committed response. */
			newMessageStartIndex?: number;
	  })
	| (OpenAIEncryptedContinuationBase & {
			strategy: "current";
			/** Raw encrypted reasoning output retained for each committed executor step. */
			reasoningStateByStep: OpenAIEncryptedReasoningState[];
	  });

export type OpenAIEncryptedContinuationOutput =
	| {
			provider: "openai";
			strategy: "cumulative";
			messages: ModelMessage[];
	  }
	| {
			provider: "openai";
			strategy: "current";
			/** Reasoning-only messages from the current accepted provider response. */
			reasoningMessages: ModelMessage[];
	  };

export interface ChatJSONResult<T> {
	data: T;
	/** Billable usage across every provider attempt made by this operation. */
	usage: TokenUsage;
	/** Usage of the accepted provider attempt, used for continuation bookkeeping. */
	accepted_usage?: TokenUsage;
	reasoning_tokens: string;
	/** Exact provider text accepted by the YAML parser, before action normalization. */
	raw_response?: string;
	providerContinuation?: OpenAIEncryptedContinuationOutput;
}

export interface SuccessVerificationVerdict {
	success: boolean;
	summary: string;
	reasons: string[];
	reopenChecklistItemIds?: string[];
	addChecklistItems?: string[];
	regenerateChecklist?: boolean;
}

export interface SuccessVerificationResult extends SuccessVerificationVerdict {
	model: string;
	provider: Provider;
	reasoningEffort?: ReasoningEffort;
	usage: TokenUsage;
}

export interface ChatYAMLTraceEvent<T = unknown> {
	caller: string;
	provider: Provider;
	model: string;
	attempt: number;
	messages: Message[];
	output?: T;
	raw_response?: string;
	usage?: TokenUsage;
	reasoning_tokens?: string;
	error?: string;
}

export interface StageModelInvocationTrace {
	step_kind: "stage_llm";
	stage: string;
	attempt: number;
	caller: string;
	provider: Provider;
	model: string;
	messages: unknown[];
	output?: unknown;
	raw_response?: string;
	usage?: TokenUsage;
	reasoning_tokens: string;
	error?: string;
	meta?: Record<string, unknown>;
}

// Cookie types
export interface CookieAnalysis {
	hasBanner: boolean;
	action: { type: "click"; ref: string } | null;
}

// Target URL types
export interface TargetURL {
	url: string;
}

export interface ChecklistDraft {
	items: string[];
}

export type ChecklistStatus = "TODO" | "DONE" | "REGRESSED";

export interface ChecklistItem {
	id: string;
	requirement: string;
	status: ChecklistStatus;
}

export type ChecklistUpdateStatus = "done" | "regressed";
export type ChecklistUpdate = Record<string, ChecklistUpdateStatus>;

// Executor types
export type PreviousStepStatus =
	| "none"
	| "progressed"
	| "no_change"
	| "blocked"
	| "opened_tab"
	| "switched_context"
	| "partial";

export interface StepResult {
	thinking: string;
	checklistUpdate?: ChecklistUpdate;
	previousStepStatus?: PreviousStepStatus;
	previousStepOutcome?: string;
	currentStateObservation?: string;
	nextActionRationale?: string;
	actions: Action[];
	done: boolean;
	result?: string;
}

export interface ExecutorResultItem {
	link: string;
	summary: string;
	downloaded_file_path?: string;
}

export interface AuthTakeoverAttemptEvent {
	step_kind: "auth_takeover_attempt";
	step?: number;
	attempt_index: number;
	messages?: unknown[];
	token_usage?: TokenUsage;
	decision?: string;
	action?: string;
	result?: string;
	outcome?: string;
	handled?: boolean;
	reason?: string;
	message?: string;
	stage?: "probe" | "result";
	current_url?: string;
	max_attempts?: number;
}

export interface MainLoopStepEntry {
	step: number;
	messages: unknown[];
	step_kind?:
		"executor_step" | "auth_takeover_attempt" | "max_step_finalization";
	auth_takeover_attempt?: AuthTakeoverAttemptEvent;
}

export type Action =
	| { type: "click"; ref: string }
	| { type: "long_press"; ref: string; durationMs?: number }
	| { type: "type"; ref: string; text: string; enter?: boolean }
	| { type: "scroll"; ref: string; deltaX?: number; deltaY?: number }
	| { type: "evaluate"; script: string }
	| { type: "dropdown_select"; ref: string; value: string }
	| { type: "navigate"; url: string }
	| { type: "switch_tab"; index: number }
	| { type: "wait"; ms: number }
	| { type: "download_current_file" }
	| { type: "upload_files"; ref: string; paths: string[] }
	| { type: "paste_file"; ref: string; path: string }
	| {
			type: "user_takeover";
			reason: string;
			category?: UserTakeoverCategory;
	  }
	| { type: "memory_write"; content: string }
	| { type: "memory_read" }
	| { type: "read_file"; path: string }
	| { type: "read_page" }
	| { type: "find_page"; query: string }
	| { type: "project_page"; target: string }
	| { type: "return_results"; results?: ExecutorResultItem[] }
	| { type: "memory_clear"; target: "memory" | "memory_result" | "all" }
	| { type: "extract_data"; root?: string }
	| { type: "agent_takeover"; request: string };

export interface StepTokenUsage {
	step: number;
	input_tokens: number;
	cached_input_tokens?: number;
	cache_write_tokens?: number;
	reasoning_tokens?: number;
	non_reasoning_output_tokens?: number;
	output_tokens: number;
	total_tokens: number;
}

export interface ExtractionStepUsage {
	parentStep: number;
	extractionIndex: number;
	usage: TokenUsage;
}

export interface RecapStageUsage {
	phase: "preprocess" | "verification";
	stage: string;
	usage?: TokenUsage;
}

export interface ExecuteResult {
	completed: boolean;
	successful: boolean;
	result: string;
	steps: number;
	tokenUsage: StepTokenUsage[];
	successVerification?: SuccessVerificationResult;
	jsonlEntry: {
		task: string;
		steps: MainLoopStepEntry[];
		completed: boolean;
		successful: boolean;
		finalResult: string | null;
		successVerification?: SuccessVerificationResult;
		modelInvocations?: StageModelInvocationTrace[];
	};
}

export interface ExecuteOptions {
	maxSteps?: number;
	requestAuthDomainCandidates?: RequestAuthDomainCandidates;
	requestAuthIdentifierForDomain?: RequestAuthIdentifierForDomain;
	requestAuthPasswordForDomain?: RequestAuthPasswordForDomain;
	recordModelInvocation?: (trace: StageModelInvocationTrace) => void;
}

export interface ExecuteActionsResult {
	pendingMemoryRead: boolean;
	interactionErrors: string[];
	toolObservations?: string[];
	pageObservation?: string;
	pageObservationMetadata?: import("../browser/page-markdown-observation.js").PageObservationMetadata;
	pageObservationInvalidated?: boolean;
	pageObservationEvents?: PageObservationEvent[];
	returnedResult?: string;
	authTakeoverAttempts?: AuthTakeoverAttemptEvent[];
	userTakeover?: {
		reason: string;
		category?: UserTakeoverCategory;
	};
}

export interface PageObservationEvent {
	kind: "bootstrap" | "read_page" | "find_page" | "project_page";
	stepNumber?: number;
	target?: string;
	query?: string;
	automatic?: boolean;
	refreshed?: boolean;
	actionIndex?: number;
	actionCount: number;
	characters: number;
	estimatedTokens: number;
	matchedNodeCount: number;
	returnedRefCount: number;
	truncated: boolean;
	unchanged: boolean;
	batchedWithPriorAction: boolean;
}
