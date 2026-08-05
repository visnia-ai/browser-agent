import type { LLMOptions, TokenUsage } from "../agents/types.js";
export type { LLMOptions };

export interface PlaintextAuthCredentialsInput {
	mode: "plaintext";
	domainUrl: string;
	username: string;
	password: string;
}

export interface EncryptedAuthCredentialsInput {
	mode: "encrypted";
	encryptedDomainUrl: string;
	encryptedUsername: string;
	encryptedPassword: string;
}

export type AuthCredentialInput =
	| PlaintextAuthCredentialsInput
	| EncryptedAuthCredentialsInput;

export type AuthCredentialsInput = AuthCredentialInput | AuthCredentialInput[];

export interface StoredEncryptedAuthCredential {
	mode: "encrypted";
	encryptedDomainUrl: string;
	encryptedUsername: string;
	encryptedPassword: string;
}

export type StoredEncryptedAuthCredentials = StoredEncryptedAuthCredential[];

export type AuthLookupPurpose = "step_context" | "auth_takeover";

export interface AuthLookupOptions {
	purpose?: AuthLookupPurpose;
}

export type RequestAuthDomainCandidates = (
	currentUrl: string,
	options?: AuthLookupOptions,
) => Promise<string[]>;

export type RequestAuthIdentifierForDomain = (
	currentUrl: string,
	options?: AuthLookupOptions,
) => Promise<string | undefined>;

export type RequestAuthPasswordForDomain = (
	currentUrl: string,
	options?: AuthLookupOptions,
) => Promise<string | undefined>;

export type AuthProbeAction =
	| "submit_credentials"
	| "advance_identifier_step"
	| "select_account"
	| "cannot_attempt";

export interface AuthFormProbeDecision {
	action: AuthProbeAction;
	usernameRef?: string;
	passwordRef?: string;
	submitRef?: string;
	continueRef?: string;
	stayLoggedInCheckboxRef?: string;
	switchIdentifierRef?: string;
	accountRef?: string;
	reason?: string;
}

export type AuthProbeOutcome =
	| "invalid_credentials"
	| "success_or_redirect"
	| "requires_user_takeover"
	| "unknown";

export interface AuthSubmitResultDecision {
	outcome: AuthProbeOutcome;
	reason?: string;
}

export interface AuthTakeoverSelectedRefsPresence {
	username: boolean;
	password: boolean;
	submit: boolean;
	continue: boolean;
	stayLoggedInCheckbox: boolean;
	switchIdentifier?: boolean;
	account?: boolean;
}

export interface AuthTakeoverAttemptTraceEntry {
	step?: number;
	attempt: number;
	stage?: "probe" | "result";
	decisionAction: AuthProbeAction;
	selectedRefsPresent: AuthTakeoverSelectedRefsPresence;
	decisionReason?: string;
	messages?: unknown[];
	token_usage?: TokenUsage;
	outcome:
		| AuthProbeOutcome
		| "advanced_identifier_step"
		| "submitted_credentials"
		| "cannot_attempt"
		| "unhandled";
	outcomeReason?: string;
	redactedPromptExcerpt?: string;
}

export interface SessionAuthTakeoverState {
	enabled: boolean;
	authProbeLLM?: LLMOptions;
	requestAuthDomainCandidates?: RequestAuthDomainCandidates;
	requestAuthIdentifierForDomain?: RequestAuthIdentifierForDomain;
	requestAuthPasswordForDomain?: RequestAuthPasswordForDomain;
	protectedRefs: Set<string>;
	suppressScreenshots: boolean;
}
