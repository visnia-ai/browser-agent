import { chatYAML, userMessage } from "../agents/providers/router.js";
import yaml from "js-yaml";
import {
	assertPasswordInputRef,
	ensureCheckboxChecked,
	readIdentifierInputByRef,
} from "../browser/interaction/auth.js";
import { click } from "../browser/interaction/click.js";
import { type as typeText } from "../browser/interaction/type.js";
import { waitForAllOpenTabsToSettle } from "../browser/interaction/wait-for-open-tabs-settle.js";
import type { Browser } from "../browser/types.js";
import type { CoreDeps } from "../core/types.js";
import {
	AUTH_TAKEOVER_FORM_SYSTEM,
	AUTH_TAKEOVER_RESULT_SYSTEM,
} from "./prompt.js";
import type {
	AuthFormProbeDecision,
	AuthProbeAction,
	AuthProbeOutcome,
	AuthSubmitResultDecision,
	AuthTakeoverAttemptTraceEntry,
	AuthTakeoverSelectedRefsPresence,
	SessionAuthTakeoverState,
} from "./types.js";
import type { TokenUsage } from "../agents/types.js";
import type { AssistantModelMessage, ModelMessage } from "ai";

const MAX_AUTH_TAKEOVER_ATTEMPTS = 4;
const AUTH_IDENTIFIER_MATCH_MARKER = "[AUTH_IDENTIFIER_MATCH]";

interface AuthTakeoverRuntimeHooks {
	chatYAML?: typeof chatYAML;
	typeText?: typeof typeText;
	click?: typeof click;
	waitForAllOpenTabsToSettle?: typeof waitForAllOpenTabsToSettle;
	log?: (message: string) => void;
	assertPasswordInputRef?: typeof assertPasswordInputRef;
	ensureCheckboxChecked?: typeof ensureCheckboxChecked;
	readIdentifierInputByRef?: typeof readIdentifierInputByRef;
}

type AuthTakeoverRuntimeResult = {
	handled: boolean;
	traceEntries: AuthTakeoverAttemptTraceEntry[];
};

function sanitizeRef(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function sanitizeReason(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeErrorDetail(error: unknown): string | undefined {
	const raw =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: String(error);
	const sanitized = raw.replace(/\s+/g, " ").trim();
	return sanitized ? sanitized.slice(0, 240) : undefined;
}

function sanitizeAuthProbeAction(value: unknown): AuthProbeAction {
	return value === "submit_credentials" ||
		value === "advance_identifier_step" ||
		value === "select_account" ||
		value === "cannot_attempt"
		? value
		: "cannot_attempt";
}

function sanitizeAuthProbeOutcome(value: unknown): AuthProbeOutcome {
	return value === "invalid_credentials" ||
		value === "success_or_redirect" ||
		value === "requires_user_takeover"
		? value
		: "unknown";
}

function protectRef(
	sessionAuth: SessionAuthTakeoverState,
	ref: string | undefined,
): void {
	if (!ref) {
		return;
	}
	sessionAuth.protectedRefs.add(ref);
	sessionAuth.suppressScreenshots = true;
}

function clearAuthProtection(sessionAuth: SessionAuthTakeoverState): void {
	sessionAuth.suppressScreenshots = false;
	sessionAuth.protectedRefs.clear();
}

function sanitizeUrlForLog(value: string): string {
	try {
		const url = new URL(value);
		return `${url.origin}${url.pathname}`;
	} catch {
		return value.trim();
	}
}

function emitAuthTakeoverLog(
	hooks: AuthTakeoverRuntimeHooks,
	event: string,
	payload?: Record<string, unknown>,
): void {
	const message =
		payload && Object.keys(payload).length > 0
			? `authTakeover:${event} ${JSON.stringify(payload)}`
			: `authTakeover:${event}`;
	if (hooks.log) {
		hooks.log(message);
		return;
	}
	console.log(`    -> ${message}`);
}

function extractKnownRefs(projection: string): Set<string> {
	const refs = new Set<string>();
	for (const match of projection.matchAll(/\bref="([^"]+)"/g)) {
		const ref = sanitizeRef(match[1]);
		if (ref) {
			refs.add(ref);
		}
	}
	return refs;
}

function buildSelectedRefsPresence(
	projection: string,
	decision: AuthFormProbeDecision,
): AuthTakeoverSelectedRefsPresence {
	const knownRefs = extractKnownRefs(projection);
	const hasRef = (ref: string | undefined): boolean =>
		Boolean(ref && knownRefs.has(ref));
	return {
		username: hasRef(decision.usernameRef),
		password: hasRef(decision.passwordRef),
		submit: hasRef(decision.submitRef),
		continue: hasRef(decision.continueRef),
		stayLoggedInCheckbox: hasRef(decision.stayLoggedInCheckboxRef),
		switchIdentifier: hasRef(decision.switchIdentifierRef),
		account: hasRef(decision.accountRef),
	};
}

function buildSafePromptExcerpt(projection: string): string | undefined {
	const excerpt = projection
		.split("\n")
		.map((line) =>
			line
				.trim()
				.replace(/\bref="[^"]+"/g, 'ref="[REDACTED]"')
				.replace(/"[^"]*"/g, '"[REDACTED]"')
				.replace(/:\s*.+$/, ": [REDACTED]"),
		)
		.filter((line) => line.length > 0)
		.slice(0, 3)
		.join(" | ");
	return excerpt.length > 0 ? excerpt.slice(0, 240) : undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactAuthIdentifierValuesFromProjection(
	projection: string,
	authIdentifier?: string,
): string {
	const redactedProjection = projection
		.split("\n")
		.map((line) => {
			if (
				!/^\s*input\b/i.test(line) ||
				!(
					/\btype="email"/i.test(line) ||
					/\bautocomplete="username"/i.test(line) ||
					/\bname="(?:email|username|login|identifier)"/i.test(line)
				)
			) {
				return line;
			}
			return line
				.replace(/\bvalue="[^"]*"/g, 'value="[REDACTED]"')
				.replace(/:\s*"[^"]*"(\s*)$/, ': "[REDACTED]"$1');
		})
		.join("\n");
	const trimmedIdentifier = authIdentifier?.trim();
	if (!trimmedIdentifier) {
		return redactedProjection;
	}
	return redactedProjection.replace(
		new RegExp(escapeRegExp(trimmedIdentifier), "gi"),
		AUTH_IDENTIFIER_MATCH_MARKER,
	);
}

function emitAttemptTrace(
	hooks: AuthTakeoverRuntimeHooks,
	trace: AuthTakeoverAttemptTraceEntry,
): void {
	emitAuthTakeoverLog(hooks, "attempt_trace", { ...trace });
}

function getProbePromptMessages(projection: string) {
	return [
		{
			role: "system" as const,
			content: AUTH_TAKEOVER_FORM_SYSTEM,
		},
		userMessage(projection),
	];
}

function getResultPromptMessages(projection: string) {
	return [
		{
			role: "system" as const,
			content: AUTH_TAKEOVER_RESULT_SYSTEM,
		},
		userMessage(projection),
	];
}

function serializePromptMessages(
	messages: ReturnType<typeof getProbePromptMessages>,
): unknown[] {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
	}));
}

function buildAssistantYamlMessage(params: {
	content: Record<string, unknown>;
	reasoningTokens?: string;
}): ModelMessage {
	const text = yaml.dump(params.content);
	const reasoning = params.reasoningTokens?.trim();
	return {
		role: "assistant",
		content: reasoning
			? [
					{ type: "reasoning", text: reasoning },
					{ type: "text", text },
				]
			: text,
	};
}

function sanitizeAuthResponseMessages(params: {
	responseMessages?: ModelMessage[];
	content: Record<string, unknown>;
	reasoningTokens?: string;
}): ModelMessage[] {
	const messages = params.responseMessages ?? [];
	let finalAssistantIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "assistant") {
			finalAssistantIndex = index;
			break;
		}
	}
	if (finalAssistantIndex < 0) {
		return [buildAssistantYamlMessage(params)];
	}

	const sanitizedText = yaml.dump(params.content);
	return messages.map((message, index): ModelMessage => {
		if (index !== finalAssistantIndex || message.role !== "assistant") {
			return message;
		}
		if (typeof message.content === "string") {
			return { ...message, content: sanitizedText };
		}
		let replacedText = false;
		const retained: Exclude<AssistantModelMessage["content"], string> = [];
		for (const part of message.content) {
			if (part.type !== "text") {
				retained.push(part);
				continue;
			}
			if (replacedText) continue;
			replacedText = true;
			const { openai: _staleOpenAITextState, ...providerOptions } =
				part.providerOptions ?? {};
			retained.push({
					type: "text" as const,
					text: sanitizedText,
					...(Object.keys(providerOptions).length > 0
						? { providerOptions }
						: {}),
				});
		}
		return {
			...message,
			content: replacedText
				? retained
				: [...retained, { type: "text", text: sanitizedText }],
		};
	});
}

function buildProbeAttemptMessages(params: {
	projection: string;
	decision: AuthFormProbeDecision;
	reasoningTokens?: string;
	responseMessages?: ModelMessage[];
}): unknown[] {
	const promptMessages = getProbePromptMessages(params.projection);
	const assistantPayload: Record<string, unknown> = {
		action: sanitizeAuthProbeAction(params.decision.action),
	};
	if (params.decision.usernameRef) {
		assistantPayload.usernameRef = params.decision.usernameRef;
	}
	if (params.decision.passwordRef) {
		assistantPayload.passwordRef = params.decision.passwordRef;
	}
	if (params.decision.submitRef) {
		assistantPayload.submitRef = params.decision.submitRef;
	}
	if (params.decision.continueRef) {
		assistantPayload.continueRef = params.decision.continueRef;
	}
	if (params.decision.stayLoggedInCheckboxRef) {
		assistantPayload.stayLoggedInCheckboxRef =
			params.decision.stayLoggedInCheckboxRef;
	}
	if (params.decision.switchIdentifierRef) {
		assistantPayload.switchIdentifierRef = params.decision.switchIdentifierRef;
	}
	if (params.decision.accountRef) {
		assistantPayload.accountRef = params.decision.accountRef;
	}
	if (params.decision.reason) {
		assistantPayload.reason = params.decision.reason;
	}
	return [
		...serializePromptMessages(promptMessages),
		...sanitizeAuthResponseMessages({
			content: assistantPayload,
			reasoningTokens: params.reasoningTokens,
			responseMessages: params.responseMessages,
		}),
	];
}

function buildResultAttemptMessages(params: {
	projection: string;
	result: AuthSubmitResultDecision;
	reasoningTokens?: string;
	responseMessages?: ModelMessage[];
}): unknown[] {
	const promptMessages = getResultPromptMessages(params.projection);
	const assistantPayload: Record<string, unknown> = {
		outcome: sanitizeAuthProbeOutcome(params.result.outcome),
	};
	if (params.result.reason) {
		assistantPayload.reason = params.result.reason;
	}
	return [
		...serializePromptMessages(promptMessages),
		...sanitizeAuthResponseMessages({
			content: assistantPayload,
			reasoningTokens: params.reasoningTokens,
			responseMessages: params.responseMessages,
		}),
	];
}

async function buildRedactedProjection(params: {
	deps: Pick<CoreDeps, "getPageProjection">;
	browser: Browser;
	sessionAuth: SessionAuthTakeoverState;
	authIdentifier?: string;
}): Promise<string> {
	const projection = await params.deps.getPageProjection(params.browser, {
		omitHrefs: true,
		redactInputRefs: [...params.sessionAuth.protectedRefs],
		redactPasswordInputs: true,
	});
	return redactAuthIdentifierValuesFromProjection(
		projection,
		params.authIdentifier,
	);
}

async function probeAuthForm(params: {
	deps: Pick<CoreDeps, "getPageProjection">;
	browser: Browser;
	sessionAuth: SessionAuthTakeoverState;
	hooks: AuthTakeoverRuntimeHooks;
	caller: string;
	currentUrl: string;
	projection?: string;
}): Promise<{
	projection: string;
	decision: AuthFormProbeDecision;
	authUsernameOrEmail?: string;
	usage?: TokenUsage;
	reasoning_tokens?: string;
	responseMessages?: ModelMessage[];
}> {
	const authUsernameOrEmail = await requestIdentifierForUrl(
		params.sessionAuth,
		params.currentUrl,
	);
	const projection =
		params.projection ??
		(await buildRedactedProjection({
			...params,
			authIdentifier: authUsernameOrEmail,
		}));
	const chatYAMLImpl = params.hooks.chatYAML ?? chatYAML;
	if (!params.sessionAuth.authProbeLLM) {
		return {
			projection,
			authUsernameOrEmail,
			decision: {
				action: "cannot_attempt",
				reason: "model_probe_unavailable",
			},
		};
	}
	let decision: AuthFormProbeDecision;
	try {
		const { data, usage, reasoning_tokens, responseMessages } =
			await chatYAMLImpl<AuthFormProbeDecision>(
				getProbePromptMessages(projection),
				params.sessionAuth.authProbeLLM,
				params.caller,
			);
		decision = {
			action: sanitizeAuthProbeAction(data.action),
			usernameRef: sanitizeRef(data.usernameRef),
			passwordRef: sanitizeRef(data.passwordRef),
			submitRef: sanitizeRef(data.submitRef),
			continueRef: sanitizeRef(data.continueRef),
			stayLoggedInCheckboxRef: sanitizeRef(data.stayLoggedInCheckboxRef),
			switchIdentifierRef: sanitizeRef(data.switchIdentifierRef),
			accountRef: sanitizeRef(data.accountRef),
			reason: sanitizeReason(data.reason),
		};
		return {
			projection,
			decision,
			authUsernameOrEmail,
			usage,
			reasoning_tokens,
			responseMessages,
		};
	} catch {
		decision = {
			action: "cannot_attempt",
			reason: "model_probe_failed",
		};
	}
	return { projection, decision, authUsernameOrEmail };
}

async function classifySubmitResult(params: {
	deps: Pick<CoreDeps, "getPageProjection">;
	browser: Browser;
	sessionAuth: SessionAuthTakeoverState;
	hooks: AuthTakeoverRuntimeHooks;
	caller: string;
	currentUrl: string;
}): Promise<{
	projection: string;
	result: AuthSubmitResultDecision;
	usage?: TokenUsage;
	reasoning_tokens?: string;
	responseMessages?: ModelMessage[];
}> {
	const authUsernameOrEmail = await requestIdentifierForUrl(
		params.sessionAuth,
		params.currentUrl,
	);
	const projection = await buildRedactedProjection({
		...params,
		authIdentifier: authUsernameOrEmail,
	});
	const chatYAMLImpl = params.hooks.chatYAML ?? chatYAML;
	try {
		const { data, usage, reasoning_tokens, responseMessages } =
			await chatYAMLImpl<AuthSubmitResultDecision>(
				getResultPromptMessages(projection),
				params.sessionAuth.authProbeLLM!,
				params.caller,
			);
		return {
			projection,
			result: {
				outcome: sanitizeAuthProbeOutcome(data.outcome),
				reason: sanitizeReason(data.reason),
			},
			usage,
			reasoning_tokens,
			responseMessages,
		};
	} catch {
		return {
			projection,
			result: {
				outcome: "unknown",
				reason: "model_result_failed",
			},
			usage: undefined,
			reasoning_tokens: undefined,
		};
	}
}

async function advanceIdentifierStep(params: {
	browser: Browser;
	usernameRef: string;
	continueRef?: string;
	identifier: string;
	enterFallback: boolean;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<void> {
	const typeTextImpl = params.hooks.typeText ?? typeText;
	const clickImpl = params.hooks.click ?? click;
	const waitForAllOpenTabsToSettleImpl =
		params.hooks.waitForAllOpenTabsToSettle ?? waitForAllOpenTabsToSettle;
	await typeTextImpl(
		params.browser,
		params.usernameRef,
		params.identifier,
		params.enterFallback,
	);
	if (params.continueRef) {
		await clickImpl(params.browser, params.continueRef);
	}
	await waitForAllOpenTabsToSettleImpl(params.browser);
}

async function submitCredentialAttempt(params: {
	browser: Browser;
	passwordRef: string;
	submitRef: string;
	stayLoggedInCheckboxRef?: string;
	password: string;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<void> {
	const typeTextImpl = params.hooks.typeText ?? typeText;
	const clickImpl = params.hooks.click ?? click;
	const ensureCheckboxCheckedImpl =
		params.hooks.ensureCheckboxChecked ?? ensureCheckboxChecked;
	const waitForAllOpenTabsToSettleImpl =
		params.hooks.waitForAllOpenTabsToSettle ?? waitForAllOpenTabsToSettle;
	await typeTextImpl(params.browser, params.passwordRef, params.password);
	const stayRef = sanitizeRef(params.stayLoggedInCheckboxRef);
	if (stayRef) {
		await ensureCheckboxCheckedImpl(params.browser, stayRef);
	}
	await clickImpl(params.browser, params.submitRef);
	await waitForAllOpenTabsToSettleImpl(params.browser);
}

function looksLikeEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function identifiersMatch(actual: string, expected: string): boolean {
	const trimmedActual = actual.trim();
	const trimmedExpected = expected.trim();
	if (looksLikeEmail(trimmedActual) && looksLikeEmail(trimmedExpected)) {
		return trimmedActual.toLowerCase() === trimmedExpected.toLowerCase();
	}
	return trimmedActual === trimmedExpected;
}

function domTextMatchesIdentifier(text: string, identifier: string): boolean {
	const trimmedText = text.trim();
	const trimmedIdentifier = identifier.trim();
	if (!trimmedText || !trimmedIdentifier) {
		return false;
	}
	if (identifiersMatch(trimmedText, trimmedIdentifier)) {
		return true;
	}
	if (looksLikeEmail(trimmedIdentifier)) {
		return trimmedText.toLowerCase().includes(trimmedIdentifier.toLowerCase());
	}
	return false;
}

function projectionContainsIdentifierText(
	projection: string,
	identifier: string,
): boolean {
	if (projection.includes(AUTH_IDENTIFIER_MATCH_MARKER)) {
		return true;
	}
	for (const match of projection.matchAll(/"([^"]*)"/g)) {
		if (domTextMatchesIdentifier(match[1] ?? "", identifier)) {
			return true;
		}
	}
	return false;
}

async function reconcileVisibleIdentifier(params: {
	browser: Browser;
	usernameRef: string;
	identifier: string;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<"matched" | "replaced" | "mismatch_not_editable"> {
	const readIdentifierInputByRefImpl =
		params.hooks.readIdentifierInputByRef ?? readIdentifierInputByRef;
	const typeTextImpl = params.hooks.typeText ?? typeText;
	const current = await readIdentifierInputByRefImpl(
		params.browser,
		params.usernameRef,
	);
	if (identifiersMatch(current.value, params.identifier)) {
		return "matched";
	}
	if (!current.editable) {
		return "mismatch_not_editable";
	}
	await typeTextImpl(params.browser, params.usernameRef, params.identifier);
	const updated = await readIdentifierInputByRefImpl(
		params.browser,
		params.usernameRef,
	);
	return identifiersMatch(updated.value, params.identifier)
		? "replaced"
		: "mismatch_not_editable";
}

async function switchIdentifier(params: {
	browser: Browser;
	switchIdentifierRef: string;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<void> {
	const clickImpl = params.hooks.click ?? click;
	const waitForAllOpenTabsToSettleImpl =
		params.hooks.waitForAllOpenTabsToSettle ?? waitForAllOpenTabsToSettle;
	await clickImpl(params.browser, params.switchIdentifierRef);
	await waitForAllOpenTabsToSettleImpl(params.browser);
}

async function selectAccountOrIdentifierSwitch(params: {
	browser: Browser;
	accountRef?: string;
	switchIdentifierRef?: string;
	hooks: AuthTakeoverRuntimeHooks;
}): Promise<"account_selected" | "identifier_switch_clicked"> {
	const clickRef = params.accountRef ?? params.switchIdentifierRef;
	if (!clickRef) {
		throw new Error("missing account chooser ref");
	}
	const clickImpl = params.hooks.click ?? click;
	const waitForAllOpenTabsToSettleImpl =
		params.hooks.waitForAllOpenTabsToSettle ?? waitForAllOpenTabsToSettle;
	await clickImpl(params.browser, clickRef);
	await waitForAllOpenTabsToSettleImpl(params.browser);
	return params.accountRef ? "account_selected" : "identifier_switch_clicked";
}

async function hasDomainCandidate(
	sessionAuth: SessionAuthTakeoverState,
	currentUrl: string,
): Promise<{ matched: boolean; error?: string }> {
	if (!sessionAuth.requestAuthDomainCandidates) {
		return { matched: false };
	}
	try {
		const matches = await sessionAuth.requestAuthDomainCandidates(currentUrl, {
			purpose: "auth_takeover",
		});
		return { matched: matches.length > 0 };
	} catch {
		return {
			matched: false,
			error: "lookup_failed",
		};
	}
}

async function requestIdentifierForUrl(
	sessionAuth: SessionAuthTakeoverState,
	currentUrl: string,
): Promise<string | undefined> {
	if (!sessionAuth.requestAuthIdentifierForDomain) {
		return undefined;
	}
	try {
		const identifier = await sessionAuth.requestAuthIdentifierForDomain(
			currentUrl,
			{
				purpose: "auth_takeover",
			},
		);
		return typeof identifier === "string" && identifier.length > 0
			? identifier
			: undefined;
	} catch {
		return undefined;
	}
}

async function requestPasswordForUrl(
	sessionAuth: SessionAuthTakeoverState,
	currentUrl: string,
): Promise<string | undefined> {
	if (!sessionAuth.requestAuthPasswordForDomain) {
		return undefined;
	}
	try {
		const password = await sessionAuth.requestAuthPasswordForDomain(
			currentUrl,
			{
				purpose: "auth_takeover",
			},
		);
		return typeof password === "string" && password.length > 0
			? password
			: undefined;
	} catch {
		return undefined;
	}
}

function validateRequiredDecisionRefs(params: {
	decision: AuthFormProbeDecision;
	selectedRefsPresent: AuthTakeoverSelectedRefsPresence;
}): string | undefined {
	if (params.decision.action === "cannot_attempt") {
		return undefined;
	}
	if (params.decision.usernameRef && !params.selectedRefsPresent.username) {
		return "username_ref_not_present";
	}
	if (params.decision.passwordRef && !params.selectedRefsPresent.password) {
		return "password_ref_not_present";
	}
	if (params.decision.submitRef && !params.selectedRefsPresent.submit) {
		return "submit_ref_not_present";
	}
	if (params.decision.continueRef && !params.selectedRefsPresent.continue) {
		return "continue_ref_not_present";
	}
	if (
		params.decision.stayLoggedInCheckboxRef &&
		!params.selectedRefsPresent.stayLoggedInCheckbox
	) {
		return "stay_logged_in_checkbox_not_present";
	}
	if (
		params.decision.switchIdentifierRef &&
		!params.selectedRefsPresent.switchIdentifier
	) {
		return "switch_identifier_ref_not_present";
	}
	if (params.decision.accountRef && !params.selectedRefsPresent.account) {
		return "account_ref_not_present";
	}
	if (
		params.decision.action === "advance_identifier_step" &&
		!params.decision.usernameRef
	) {
		return "missing_identifier_refs";
	}
	if (
		params.decision.action === "select_account" &&
		!params.decision.accountRef &&
		!params.decision.switchIdentifierRef
	) {
		return "missing_select_account_refs";
	}
	if (
		params.decision.action === "submit_credentials" &&
		(!params.decision.passwordRef || !params.decision.submitRef)
	) {
		return "missing_submit_refs";
	}
	if (
		params.decision.action === "advance_identifier_step" &&
		!params.selectedRefsPresent.username
	) {
		return "identifier_refs_not_present";
	}
	if (
		params.decision.action === "submit_credentials" &&
		(!params.selectedRefsPresent.password || !params.selectedRefsPresent.submit)
	) {
		return "submit_refs_not_present";
	}
	return undefined;
}

export async function attemptAutomatedAuthTakeover(params: {
	deps: Pick<CoreDeps, "getPageProjection" | "getCurrentURL">;
	browser: Browser;
	sessionAuth: SessionAuthTakeoverState | undefined;
	stepBaseIndex?: number;
	hooks?: AuthTakeoverRuntimeHooks;
}): Promise<AuthTakeoverRuntimeResult> {
	const sessionAuth = params.sessionAuth;
	const hooks = params.hooks ?? {};
	const traceEntries: AuthTakeoverAttemptTraceEntry[] = [];
	let identifierConfirmed = false;
	const getNextAuthStepNumber = (): number | undefined =>
		typeof params.stepBaseIndex === "number"
			? params.stepBaseIndex + traceEntries.length + 1
			: undefined;

	function returnUnhandled(
		reason: string,
		payload?: Record<string, unknown>,
	): AuthTakeoverRuntimeResult {
		emitAuthTakeoverLog(hooks, "returning_unhandled", {
			reason,
			...(payload ?? {}),
		});
		return { handled: false, traceEntries };
	}

	if (
		!sessionAuth?.enabled ||
		!sessionAuth.requestAuthDomainCandidates ||
		!sessionAuth.requestAuthIdentifierForDomain ||
		!sessionAuth.requestAuthPasswordForDomain
	) {
		emitAuthTakeoverLog(hooks, "skipped_preconditions", {
			enabled: sessionAuth?.enabled ?? false,
			hasAuthProbeLLM: Boolean(sessionAuth?.authProbeLLM),
			hasDomainCandidateCallback: Boolean(
				sessionAuth?.requestAuthDomainCandidates,
			),
			hasIdentifierLookupCallback: Boolean(
				sessionAuth?.requestAuthIdentifierForDomain,
			),
			hasPasswordLookupCallback: Boolean(
				sessionAuth?.requestAuthPasswordForDomain,
			),
		});
		return returnUnhandled("preconditions");
	}

	const currentUrl = await params.deps.getCurrentURL(params.browser);
	const initialCandidateCheck = await hasDomainCandidate(
		sessionAuth,
		currentUrl,
	);
	emitAuthTakeoverLog(hooks, "domain_candidate_check", {
		stage: "initial",
		currentUrl: sanitizeUrlForLog(currentUrl),
		matched: initialCandidateCheck.matched,
		...(initialCandidateCheck.error
			? { error: initialCandidateCheck.error }
			: {}),
	});
	if (!initialCandidateCheck.matched) {
		return returnUnhandled("no_domain_candidate_initial");
	}

	for (
		let authAttempt = 0;
		authAttempt < MAX_AUTH_TAKEOVER_ATTEMPTS;
		authAttempt += 1
	) {
		const probeStepNumber = getNextAuthStepNumber();
		emitAuthTakeoverLog(hooks, "attempt_started", {
			attempt: authAttempt + 1,
			...(typeof probeStepNumber === "number" ? { step: probeStepNumber } : {}),
			maxAttempts: MAX_AUTH_TAKEOVER_ATTEMPTS,
		});
		const authUrl = await params.deps.getCurrentURL(params.browser);
		const stepCandidateCheck = await hasDomainCandidate(sessionAuth, authUrl);
		emitAuthTakeoverLog(hooks, "domain_candidate_check", {
			stage: "attempt",
			attempt: authAttempt + 1,
			...(typeof probeStepNumber === "number" ? { step: probeStepNumber } : {}),
			currentUrl: sanitizeUrlForLog(authUrl),
			matched: stepCandidateCheck.matched,
			...(stepCandidateCheck.error ? { error: stepCandidateCheck.error } : {}),
		});

		if (!stepCandidateCheck.matched) {
			return returnUnhandled("no_domain_candidate_attempt", {
				attempt: authAttempt + 1,
			});
		}

		const {
			projection,
			decision,
			authUsernameOrEmail,
			usage: probeUsage,
			reasoning_tokens: probeReasoningTokens,
			responseMessages: probeResponseMessages,
		} = await probeAuthForm({
			deps: params.deps,
			browser: params.browser,
			sessionAuth,
			hooks,
			caller:
				typeof probeStepNumber === "number"
					? `authTakeover:probe:step${probeStepNumber}`
					: "authTakeover:probe",
			currentUrl: authUrl,
		});
		const selectedRefsPresent = buildSelectedRefsPresence(projection, decision);
		emitAuthTakeoverLog(hooks, "auth_fields_detected", {
			attempt: authAttempt + 1,
			...(typeof probeStepNumber === "number" ? { step: probeStepNumber } : {}),
			hasUsernameRef: selectedRefsPresent.username,
			hasPasswordRef: selectedRefsPresent.password,
			hasSubmitRef: selectedRefsPresent.submit,
			hasContinueRef: selectedRefsPresent.continue,
			hasStayLoggedInCheckboxRef: selectedRefsPresent.stayLoggedInCheckbox,
			hasSwitchIdentifierRef: selectedRefsPresent.switchIdentifier === true,
			hasAccountRef: selectedRefsPresent.account === true,
		});
		const selectedRefFailure = validateRequiredDecisionRefs({
			decision,
			selectedRefsPresent,
		});
		const probeTrace: AuthTakeoverAttemptTraceEntry = {
			...(typeof probeStepNumber === "number" ? { step: probeStepNumber } : {}),
			attempt: authAttempt + 1,
			stage: "probe",
			decisionAction: sanitizeAuthProbeAction(decision.action),
			selectedRefsPresent,
			decisionReason: sanitizeReason(decision.reason),
			messages: buildProbeAttemptMessages({
				projection,
				decision,
				reasoningTokens: probeReasoningTokens,
				responseMessages: probeResponseMessages,
			}),
			token_usage: probeUsage,
			outcome:
				selectedRefFailure || decision.action === "cannot_attempt"
					? "cannot_attempt"
					: "unhandled",
			outcomeReason:
				selectedRefFailure ||
				sanitizeReason(decision.reason) ||
				"model_declined",
			redactedPromptExcerpt: buildSafePromptExcerpt(projection),
		};
		if (selectedRefFailure || decision.action === "cannot_attempt") {
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			if (decision.reason === "model_probe_unavailable") {
				continue;
			}
			return returnUnhandled(selectedRefFailure ?? "cannot_attempt", {
				attempt: authAttempt + 1,
				action: decision.action,
			});
		}

		if (decision.action === "select_account") {
			try {
				const outcome = await selectAccountOrIdentifierSwitch({
					browser: params.browser,
					accountRef: decision.accountRef,
					switchIdentifierRef: decision.switchIdentifierRef,
					hooks,
				});
				emitAuthTakeoverLog(hooks, outcome, {
					attempt: authAttempt + 1,
					...(typeof probeStepNumber === "number"
						? { step: probeStepNumber }
						: {}),
				});
				probeTrace.outcome = "advanced_identifier_step";
				probeTrace.outcomeReason = outcome;
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				identifierConfirmed = outcome === "account_selected";
				continue;
			} catch {
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = "account_select_failed";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("account_select_failed", {
					attempt: authAttempt + 1,
				});
			}
		}

		if (decision.action === "advance_identifier_step") {
			const identifier = await requestIdentifierForUrl(sessionAuth, authUrl);
			if (!identifier) {
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = "identifier_lookup_missed";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("identifier_lookup_missed", {
					attempt: authAttempt + 1,
				});
			}
			protectRef(sessionAuth, decision.usernameRef);
			try {
				const usedEnterFallback = !decision.continueRef;
				await advanceIdentifierStep({
					browser: params.browser,
					usernameRef: decision.usernameRef!,
					continueRef: decision.continueRef,
					identifier,
					enterFallback: usedEnterFallback,
					hooks,
				});
				emitAuthTakeoverLog(hooks, "identifier_step_completed", {
					attempt: authAttempt + 1,
					...(typeof probeStepNumber === "number"
						? { step: probeStepNumber }
						: {}),
					usedContinueRef: Boolean(decision.continueRef),
					usedEnterFallback,
				});
				identifierConfirmed = true;
				probeTrace.outcome = "advanced_identifier_step";
				probeTrace.outcomeReason = "identifier_step_completed";
			} catch (error) {
				const errorDetail = sanitizeErrorDetail(error);
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = errorDetail
					? `identifier_step_failed: ${errorDetail}`
					: "identifier_step_failed";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("identifier_step_failed", {
					attempt: authAttempt + 1,
					...(errorDetail ? { error: errorDetail } : {}),
				});
			}
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			continue;
		}

		if (decision.action !== "submit_credentials") {
			probeTrace.outcome = "cannot_attempt";
			probeTrace.outcomeReason = "model_declined";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("form_probe_declined", {
				attempt: authAttempt + 1,
				action: decision.action,
			});
		}

		const identifier =
			decision.usernameRef || !identifierConfirmed
				? await requestIdentifierForUrl(sessionAuth, authUrl)
				: undefined;
		if ((decision.usernameRef || !identifierConfirmed) && !identifier) {
			probeTrace.outcome = "unhandled";
			probeTrace.outcomeReason = "identifier_lookup_missed";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("identifier_lookup_missed", {
				attempt: authAttempt + 1,
			});
		}
		let credentialSubmitOutcomeReason: string | undefined;
		if (decision.usernameRef) {
			protectRef(sessionAuth, decision.usernameRef);
			try {
				const reconcileResult = await reconcileVisibleIdentifier({
					browser: params.browser,
					usernameRef: decision.usernameRef,
					identifier: identifier!,
					hooks,
				});
				if (reconcileResult === "mismatch_not_editable") {
					if (decision.switchIdentifierRef) {
						await switchIdentifier({
							browser: params.browser,
							switchIdentifierRef: decision.switchIdentifierRef,
							hooks,
						});
						emitAuthTakeoverLog(hooks, "identifier_switch_clicked", {
							attempt: authAttempt + 1,
							...(typeof probeStepNumber === "number"
								? { step: probeStepNumber }
								: {}),
						});
						probeTrace.outcome = "advanced_identifier_step";
						probeTrace.outcomeReason = "identifier_switch_clicked";
						traceEntries.push(probeTrace);
						emitAttemptTrace(hooks, probeTrace);
						identifierConfirmed = false;
						continue;
					}
					probeTrace.outcome = "unhandled";
					probeTrace.outcomeReason = "identifier_mismatch";
					traceEntries.push(probeTrace);
					emitAttemptTrace(hooks, probeTrace);
					return returnUnhandled("identifier_mismatch", {
						attempt: authAttempt + 1,
					});
				}
				identifierConfirmed = true;
				credentialSubmitOutcomeReason =
					reconcileResult === "matched"
						? "identifier_already_matched"
						: "identifier_replaced";
			} catch {
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = "identifier_read_failed";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("identifier_read_failed", {
					attempt: authAttempt + 1,
				});
			}
		} else if (!identifierConfirmed) {
			if (
				identifier &&
				projectionContainsIdentifierText(projection, identifier)
			) {
				identifierConfirmed = true;
				credentialSubmitOutcomeReason = "identifier_text_matched";
				emitAuthTakeoverLog(hooks, "identifier_text_matched", {
					attempt: authAttempt + 1,
					...(typeof probeStepNumber === "number"
						? { step: probeStepNumber }
						: {}),
				});
			} else if (decision.switchIdentifierRef) {
				try {
					await switchIdentifier({
						browser: params.browser,
						switchIdentifierRef: decision.switchIdentifierRef,
						hooks,
					});
				} catch {
					probeTrace.outcome = "unhandled";
					probeTrace.outcomeReason = "identifier_switch_failed";
					traceEntries.push(probeTrace);
					emitAttemptTrace(hooks, probeTrace);
					return returnUnhandled("identifier_switch_failed", {
						attempt: authAttempt + 1,
					});
				}
				emitAuthTakeoverLog(hooks, "identifier_switch_clicked", {
					attempt: authAttempt + 1,
					...(typeof probeStepNumber === "number"
						? { step: probeStepNumber }
						: {}),
				});
				probeTrace.outcome = "advanced_identifier_step";
				probeTrace.outcomeReason = "identifier_switch_clicked";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				continue;
			} else {
				probeTrace.outcome = "unhandled";
				probeTrace.outcomeReason = "identifier_not_verifiable";
				traceEntries.push(probeTrace);
				emitAttemptTrace(hooks, probeTrace);
				return returnUnhandled("identifier_not_verifiable", {
					attempt: authAttempt + 1,
				});
			}
		}

		protectRef(sessionAuth, decision.passwordRef);
		const assertPasswordInputRefImpl =
			hooks.assertPasswordInputRef ?? assertPasswordInputRef;
		try {
			await assertPasswordInputRefImpl(params.browser, decision.passwordRef!);
		} catch {
			probeTrace.outcome = "unhandled";
			probeTrace.outcomeReason = "password_ref_verification_failed";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("password_ref_verification_failed", {
				attempt: authAttempt + 1,
			});
		}

		const password = await requestPasswordForUrl(sessionAuth, authUrl);
		if (!password) {
			probeTrace.outcome = "unhandled";
			probeTrace.outcomeReason = "password_lookup_missed";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("password_lookup_missed", {
				attempt: authAttempt + 1,
			});
		}

		try {
			await submitCredentialAttempt({
				browser: params.browser,
				passwordRef: decision.passwordRef!,
				submitRef: decision.submitRef!,
				stayLoggedInCheckboxRef: decision.stayLoggedInCheckboxRef,
				password,
				hooks,
			});
		} catch {
			probeTrace.outcome = "unhandled";
			probeTrace.outcomeReason = "credential_submit_failed";
			traceEntries.push(probeTrace);
			emitAttemptTrace(hooks, probeTrace);
			return returnUnhandled("credential_submit_failed", {
				attempt: authAttempt + 1,
			});
		}
		probeTrace.outcome = "submitted_credentials";
		probeTrace.outcomeReason = credentialSubmitOutcomeReason
			? `${credentialSubmitOutcomeReason}; credentials_submitted`
			: "credentials_submitted";
		traceEntries.push(probeTrace);
		emitAttemptTrace(hooks, probeTrace);

		const resultStepNumber = getNextAuthStepNumber();
		const submitResult = await classifySubmitResult({
			deps: params.deps,
			browser: params.browser,
			sessionAuth,
			hooks,
			currentUrl: authUrl,
			caller:
				typeof resultStepNumber === "number"
					? `authTakeover:result:step${resultStepNumber}`
					: "authTakeover:result",
		});
		const resultTrace: AuthTakeoverAttemptTraceEntry = {
			...(typeof resultStepNumber === "number"
				? { step: resultStepNumber }
				: {}),
			attempt: authAttempt + 1,
			stage: "result",
			decisionAction: sanitizeAuthProbeAction(decision.action),
			selectedRefsPresent,
			decisionReason: sanitizeReason(decision.reason),
			messages: buildResultAttemptMessages({
				projection: submitResult.projection,
				result: submitResult.result,
				reasoningTokens: submitResult.reasoning_tokens,
				responseMessages: submitResult.responseMessages,
			}),
			token_usage: submitResult.usage,
			outcome: submitResult.result.outcome,
			outcomeReason: submitResult.result.reason ?? undefined,
			redactedPromptExcerpt: buildSafePromptExcerpt(submitResult.projection),
		};
		traceEntries.push(resultTrace);
		emitAttemptTrace(hooks, resultTrace);

		if (resultTrace.outcome !== "success_or_redirect") {
			return returnUnhandled("real_result_not_success_or_redirect", {
				attempt: authAttempt + 1,
				outcome: resultTrace.outcome,
			});
		}

		clearAuthProtection(sessionAuth);
		return { handled: true, traceEntries };
	}

	emitAuthTakeoverLog(hooks, "attempt_budget_exhausted", {
		maxAttempts: MAX_AUTH_TAKEOVER_ATTEMPTS,
	});
	return returnUnhandled("attempt_budget_exhausted", {
		maxAttempts: MAX_AUTH_TAKEOVER_ATTEMPTS,
	});
}
