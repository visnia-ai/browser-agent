import yaml from "js-yaml";
import {
	configFeatureFlags,
	shouldUseCumulativeProjectionHistory,
} from "../config-feature-flags.js";
import {
	stripProjectionContextFromHistoryPayload,
	stripPayloadForHistory,
} from "../agents/executor-utils/history-payload.js";
import { logActionBoundary } from "../agents/executor-utils/action-boundary-logging.js";
import {
	buildMaxStepFinalizationMessages,
	formatStepForPrompt,
} from "../agents/executor-utils/step-execution.js";
import {
	buildDownloadedFilesPayload,
	buildWorkspaceFilesPayload,
} from "../agents/executor-utils/step-context.js";
import { canonicalizeStepDownloadedFilePaths } from "../agents/executor-utils/downloaded-file-paths.js";
import { buildHistoryMessagesFromFullStepHistory } from "./history-adapter.js";
import { normalizeUserTakeoverCategory } from "../user-action-types.js";
import { fitStepPromptToBudget } from "./prompt-budget.js";
import type {
	BrowseInput,
	BrowseResult,
	CoreDeps,
	CreatePromptForStepInput,
	CreatePromptForStepResult,
	ProcessModelStepOutputInput,
	ProcessModelStepOutputResult,
	StepInput,
	StepInputByMode,
	StepHistoryEntry,
	StepResult,
	StepResultByMode,
} from "./types.js";
import { SessionNotFoundError } from "./session.js";
import type { BrowserSession } from "./session-registry.js";
import type { Tab } from "../browser/types.js";
import {
	ModelStepActionContractError,
	processModelStepOutput,
} from "./process-model-step-output.js";
import { Action } from "../agents/types.js";
import { attemptAutomatedAuthTakeover } from "../auth/runtime.js";
import { verifyTaskSuccess as defaultVerifyTaskSuccess } from "../agents/success-verifier.js";
import { shouldLogTimingDuration } from "../timing-logs.js";
import { shouldIncludeExecutorReasoningHistory } from "../agents/prompts.js";
import { resolveProjectionHistoryContext } from "./projection-history.js";
import {
	applyChecklistUpdate,
	formatChecklistForPrompt,
	normalizeChecklistUpdate,
} from "./checklist-state.js";

const PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_COUNT = 2;
const PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_DELAY_MS = 150;
const EMPTY_PROJECTION_RETRY_DELAY_MS = 3_000;
const EMPTY_PROJECTION_MAX_RETRIES = 2;
const BLANK_DOWNLOAD_TAB_CONTEXT_NOTE =
	"Ignored blank download tab; stayed on source tab.";

function getSessionOrThrow(deps: CoreDeps, port: number): BrowserSession {
	const session = deps.registry.get(port);
	if (!session) {
		throw new SessionNotFoundError(port);
	}
	return session;
}

function prepareCommittedProjectionHistorySnapshot(
	session: BrowserSession,
	historyLength: number,
	cumulativeProjectionHistoryEnabled: boolean,
): string | undefined {
	if (!cumulativeProjectionHistoryEnabled) {
		session.projectionHistory = {};
		return undefined;
	}

	const state = session.projectionHistory;
	const pending = state.pending;
	if (pending) {
		if (historyLength === pending.sourceHistoryLength + 1) {
			state.committed = {
				...pending,
				sourceHistoryLength: historyLength,
			};
			state.pending = undefined;
		} else if (historyLength === pending.sourceHistoryLength) {
			state.pending = undefined;
		} else {
			session.projectionHistory = {};
			return undefined;
		}
	}
	if (state.committed && state.committed.sourceHistoryLength > historyLength) {
		session.projectionHistory = {};
		return undefined;
	}
	return state.committed?.canDiffFrom
		? state.committed.canonicalProjection
		: undefined;
}

function shouldProtectAuthContext(session: BrowserSession): boolean {
	const sessionAuth = session.authTakeover;
	if (
		!sessionAuth?.suppressScreenshots ||
		sessionAuth.protectedRefs.size === 0
	) {
		return false;
	}
	return true;
}

async function getAuthUsernameForContext(params: {
	session: BrowserSession;
	currentUrl: string;
}): Promise<string | undefined> {
	const sessionAuth = params.session.authTakeover;
	if (
		!sessionAuth?.enabled ||
		!sessionAuth.requestAuthDomainCandidates ||
		!sessionAuth.requestAuthIdentifierForDomain
	) {
		return undefined;
	}
	try {
		const candidates = await sessionAuth.requestAuthDomainCandidates(
			params.currentUrl,
			{ purpose: "step_context" },
		);
		if (candidates.length === 0) {
			return undefined;
		}
		const identifier = await sessionAuth.requestAuthIdentifierForDomain(
			params.currentUrl,
			{ purpose: "step_context" },
		);
		return typeof identifier === "string" && identifier.trim()
			? identifier
			: undefined;
	} catch {
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBlankDownloadArtifactTab(tab: Tab): boolean {
	const normalizedUrl = tab.url.trim().toLowerCase();
	const normalizedTitle = tab.title.trim().toLowerCase();
	return (
		(normalizedUrl === "" ||
			normalizedUrl === "about:blank" ||
			normalizedUrl === ":") &&
		(normalizedTitle === "" || normalizedTitle === "new tab")
	);
}

function firstMeaningfulNewTab(tabs: Tab[]): Tab | undefined {
	return tabs.find((tab) => !isBlankDownloadArtifactTab(tab));
}

async function restoreSourceTabAfterBlankDownloadTab(input: {
	deps: CoreDeps;
	session: BrowserSession;
	openTabs: Tab[];
	currentUrl: string;
	newlyOpenedTabs: Tab[];
}): Promise<{ currentUrl: string; restored: boolean }> {
	if (!input.newlyOpenedTabs.some(isBlankDownloadArtifactTab)) {
		return { currentUrl: input.currentUrl, restored: false };
	}
	const currentTab =
		input.openTabs.find((tab) => tab.url === input.currentUrl) ??
		input.openTabs.find(
			(tab) => tab.targetId === input.session.browser.currentTargetId,
		);
	if (currentTab && !isBlankDownloadArtifactTab(currentTab)) {
		return { currentUrl: input.currentUrl, restored: false };
	}
	const sourceTab = input.openTabs.find(
		(tab) =>
			!input.newlyOpenedTabs.some(
				(newTab) => newTab.targetId === tab.targetId,
			) && !isBlankDownloadArtifactTab(tab),
	);
	if (!sourceTab) {
		return { currentUrl: input.currentUrl, restored: false };
	}
	await input.deps.switchTab(input.session.browser, sourceTab.targetId);
	return {
		currentUrl: await input.deps.getCurrentURL(input.session.browser),
		restored: true,
	};
}

function logStateExtractionPhase(params: {
	stepNumber?: number;
	phase: string;
	durationMs: number;
	status?: "ok" | "error";
	detail?: string;
}): void {
	const status = params.status ?? "ok";
	if (!shouldLogTimingDuration(params.durationMs, status)) {
		return;
	}
	const prefix =
		typeof params.stepNumber === "number"
			? `  [step ${params.stepNumber} state-extraction]`
			: "  [state-extraction]";
	const detail = params.detail ? ` | ${params.detail}` : "";
	console.log(
		`${prefix} ${params.phase} status=${status} duration_ms=${params.durationMs}${detail}`,
	);
}

function logCreatePromptTotal(params: {
	stepNumber?: number;
	durationMs: number;
	status?: "ok" | "error";
}): void {
	const status = params.status ?? "ok";
	if (!shouldLogTimingDuration(params.durationMs, status)) {
		return;
	}
	const prefix =
		typeof params.stepNumber === "number"
			? `  [step ${params.stepNumber} create-prompt]`
			: "  [create-prompt]";
	console.log(
		`${prefix} total status=${status} duration_ms=${params.durationMs}`,
	);
}

async function timeStateExtractionPhase<T>(
	params: {
		stepNumber?: number;
		phase: string;
		detail?: () => string | undefined;
	},
	fn: () => Promise<T>,
): Promise<T> {
	const startedAt = Date.now();
	try {
		const result = await fn();
		logStateExtractionPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "ok",
			detail: params.detail?.(),
		});
		return result;
	} catch (error) {
		logStateExtractionPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "error",
			detail: toErrorMessage(error),
		});
		throw error;
	}
}

function timeStateExtractionPhaseSync<T>(
	params: {
		stepNumber?: number;
		phase: string;
		detail?: () => string | undefined;
	},
	fn: () => T,
): T {
	const startedAt = Date.now();
	try {
		const result = fn();
		logStateExtractionPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "ok",
			detail: params.detail?.(),
		});
		return result;
	} catch (error) {
		logStateExtractionPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "error",
			detail: toErrorMessage(error),
		});
		throw error;
	}
}

function isProjectionBlank(projection: string): boolean {
	return projection.trim().length === 0;
}

async function fetchProjectionWithRetry(params: {
	stepNumber?: number;
	getProjection: () => Promise<string>;
}): Promise<string> {
	let projection = await params.getProjection();
	if (!isProjectionBlank(projection)) return projection;

	for (let retry = 1; retry <= EMPTY_PROJECTION_MAX_RETRIES; retry++) {
		console.warn(
			`[core][step ${params.stepNumber ?? "?"}] Semantic projection is empty. Waiting ${EMPTY_PROJECTION_RETRY_DELAY_MS}ms before retry ${retry}/${EMPTY_PROJECTION_MAX_RETRIES}.`,
		);
		await timeStateExtractionPhase(
			{
				stepNumber: params.stepNumber,
				phase: `getPageProjection:emptyRetryWait${retry}`,
				detail: () => `wait_ms=${EMPTY_PROJECTION_RETRY_DELAY_MS}`,
			},
			async () => await sleep(EMPTY_PROJECTION_RETRY_DELAY_MS),
		);
		projection = await params.getProjection();
		if (!isProjectionBlank(projection)) return projection;
	}

	console.warn(
		`[core][step ${params.stepNumber ?? "?"}] Semantic projection is still empty after ${EMPTY_PROJECTION_MAX_RETRIES} retries. Continuing with an empty projection.`,
	);
	return projection;
}

export async function createPromptForStep(
	deps: CoreDeps,
	input: CreatePromptForStepInput,
): Promise<CreatePromptForStepResult> {
	const startedAt = Date.now();
	try {
		const result = await createPromptForStepImpl(deps, input);
		logCreatePromptTotal({
			stepNumber: input.stepNumber,
			durationMs: Date.now() - startedAt,
			status: "ok",
		});
		return result;
	} catch (error) {
		logCreatePromptTotal({
			stepNumber: input.stepNumber,
			durationMs: Date.now() - startedAt,
			status: "error",
		});
		throw error;
	}
}

async function createPromptForStepImpl(
	deps: CoreDeps,
	input: CreatePromptForStepInput,
): Promise<CreatePromptForStepResult> {
	const session = getSessionOrThrow(deps, input.port);
	const executorPromptOptions = {
		provider: input.llmOptions?.provider,
		semanticProjectionHistory: shouldUseCumulativeProjectionHistory(
			configFeatureFlags,
		)
			? ("cumulative" as const)
			: ("current" as const),
	};
	const cumulativeProjectionHistoryEnabled =
		executorPromptOptions.semanticProjectionHistory === "cumulative";

	session.lastTask = input.userTask;

	const previousCanonicalProjection = prepareCommittedProjectionHistorySnapshot(
		session,
		input.stepsHistory.length,
		cumulativeProjectionHistoryEnabled,
	);
	let currentUrl = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "getCurrentURL",
		},
		async () => await deps.getCurrentURL(session.browser),
	);
	logStateExtractionPhase({
		stepNumber: input.stepNumber,
		phase: "getCurrentURL:value",
		durationMs: 0,
		detail: currentUrl,
	});
	const protectAuthContext = shouldProtectAuthContext(session);
	const domOptions = {
		omitHrefs: true,
		redactInputRefs: protectAuthContext
			? [...(session.authTakeover?.protectedRefs || [])]
			: [],
		redactPasswordInputs: protectAuthContext,
	};
	const promptInteractionErrors = [...session.previousInteractionErrors];
	let projection = "";
	let validRefs: string[] = [];
	const getProjectionWithRetry = async (): Promise<string> =>
		await fetchProjectionWithRetry({
			stepNumber: input.stepNumber,
			getProjection: async () => {
				const options =
					typeof input.stepNumber === "number"
						? { ...domOptions, stepNumber: input.stepNumber }
						: domOptions;
				return await deps.getPageProjection(session.browser, options);
			},
		});
	const refreshProjectionContext = async (): Promise<void> => {
		try {
			projection = await timeStateExtractionPhase(
				{
					stepNumber: input.stepNumber,
					phase: "getPageProjection",
					detail: () => `projection_chars=${projection.length}`,
				},
				async () => {
					projection = await getProjectionWithRetry();
					return projection;
				},
			);
			validRefs = timeStateExtractionPhaseSync(
				{
					stepNumber: input.stepNumber,
					phase: "extractValidRefs",
					detail: () => `valid_refs=${validRefs.length}`,
				},
				() => {
					validRefs = deps.extractValidRefs(projection);
					return validRefs;
				},
			);
		} catch (error) {
			const message = toErrorMessage(error);
			if (isStaleContextNodeError(message)) {
				try {
					projection = await timeStateExtractionPhase(
						{
							stepNumber: input.stepNumber,
							phase: "getPageProjection:retry",
							detail: () => `projection_chars=${projection.length}`,
						},
						async () => {
							projection = await getProjectionWithRetry();
							return projection;
						},
					);
					validRefs = timeStateExtractionPhaseSync(
						{
							stepNumber: input.stepNumber,
							phase: "extractValidRefs:retry",
							detail: () => `valid_refs=${validRefs.length}`,
						},
						() => {
							validRefs = deps.extractValidRefs(projection);
							return validRefs;
						},
					);
				} catch (retryError) {
					promptInteractionErrors.push(
						`context(projection): ${toErrorMessage(retryError)}`,
					);
				}
			} else {
				promptInteractionErrors.push(`context(projection): ${message}`);
			}
		}
	};
	await refreshProjectionContext();
	let openTabs = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "listTabs",
		},
		async () => await deps.listTabs(session.browser),
	);
	logStateExtractionPhase({
		stepNumber: input.stepNumber,
		phase: "listTabs:value",
		durationMs: 0,
		detail: `tabs=${openTabs.length}`,
	});
	let newlyOpenedTabs = deps.getNewlyOpenedTabs(
		session.previousStepTabs,
		openTabs,
	);
	let autoTabSwitchNote: string | undefined;
	if ((input.autoSwitchToNewTab ?? true) && newlyOpenedTabs.length > 0) {
		await timeStateExtractionPhase(
			{
				stepNumber: input.stepNumber,
				phase: "autoSwitchToNewTab",
				detail: () =>
					`newly_opened_tabs=${newlyOpenedTabs.length} switched=${autoTabSwitchNote ? "yes" : "no"}`,
			},
			async () => {
				const firstNewTab = firstMeaningfulNewTab(newlyOpenedTabs);
				if (!firstNewTab) {
					return;
				}
				const currentTabIndex = await deps.resolveCurrentTabIndex({
					b: session.browser,
					openTabs,
					currentUrl,
				});
				const currentTabTargetId = openTabs[currentTabIndex]?.targetId;
				if (currentTabTargetId !== firstNewTab.targetId) {
					console.log(
						`Auto-switching to first newly opened tab: "${deps.formatTabTitle(firstNewTab)}"`,
					);
					await deps.switchTab(session.browser, firstNewTab.targetId);
					currentUrl = await timeStateExtractionPhase(
						{
							stepNumber: input.stepNumber,
							phase: "getCurrentURL:autoSwitch",
						},
						async () => await deps.getCurrentURL(session.browser),
					);
					logStateExtractionPhase({
						stepNumber: input.stepNumber,
						phase: "getCurrentURL:autoSwitch:value",
						durationMs: 0,
						detail: currentUrl,
					});
					await refreshProjectionContext();
					openTabs = await timeStateExtractionPhase(
						{
							stepNumber: input.stepNumber,
							phase: "listTabs:autoSwitch",
						},
						async () => await deps.listTabs(session.browser),
					);
					logStateExtractionPhase({
						stepNumber: input.stepNumber,
						phase: "listTabs:autoSwitch:value",
						durationMs: 0,
						detail: `tabs=${openTabs.length}`,
					});
					newlyOpenedTabs = deps.getNewlyOpenedTabs(
						session.previousStepTabs,
						openTabs,
					);
					autoTabSwitchNote = "Auto-switched to first newly opened tab.";
				}
			},
		);
	}

	let preStepScreenshotDataUrl = "";
	if (
		configFeatureFlags.preStepScreenshotInLatestUserPrompt &&
		!protectAuthContext
	) {
		for (
			let attempt = 1;
			attempt <= PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_COUNT + 1;
			attempt++
		) {
			try {
				preStepScreenshotDataUrl = await timeStateExtractionPhase(
					{
						stepNumber: input.stepNumber,
						phase:
							attempt === 1
								? "capturePreStepScreenshotDataUrl"
								: `capturePreStepScreenshotDataUrl:retry${attempt}`,
						detail: () =>
							preStepScreenshotDataUrl
								? `image_chars=${preStepScreenshotDataUrl.length}`
								: undefined,
					},
					async () => {
						preStepScreenshotDataUrl =
							await deps.capturePreStepScreenshotDataUrl({
								b: session.browser,
								validRefs,
							});
						return preStepScreenshotDataUrl;
					},
				);
				break;
			} catch (error) {
				const message = toErrorMessage(error);
				const canRetryStaleNodeError =
					attempt <= PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_COUNT &&
					isStaleContextNodeError(message);
				if (canRetryStaleNodeError) {
					await timeStateExtractionPhase(
						{
							stepNumber: input.stepNumber,
							phase: `capturePreStepScreenshotDataUrl:retryWait${attempt}`,
							detail: () =>
								`wait_ms=${PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_DELAY_MS}`,
						},
						async () =>
							await sleep(PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_DELAY_MS),
					);
					continue;
				}
				promptInteractionErrors.push(
					`context(pre_step_screenshot): ${message}`,
				);
				break;
			}
		}
	}

	const currentTab = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "resolveCurrentTabIndex",
		},
		async () =>
			await deps.resolveCurrentTabIndex({
				b: session.browser,
				openTabs,
				currentUrl,
			}),
	);
	logStateExtractionPhase({
		stepNumber: input.stepNumber,
		phase: "resolveCurrentTabIndex:value",
		durationMs: 0,
		detail: `current_tab=${currentTab}`,
	});
	let downloadedFilesState: ReturnType<typeof buildDownloadedFilesPayload>;
	downloadedFilesState = timeStateExtractionPhaseSync(
		{
			stepNumber: input.stepNumber,
			phase: "buildDownloadedFilesPayload",
			detail: () =>
				`downloaded_files=${downloadedFilesState.downloadedFiles.length} new_files=${downloadedFilesState.newFilePaths.size}`,
		},
		() => {
			downloadedFilesState = buildDownloadedFilesPayload({
				downloadDir: session.browser.downloadDir,
				downloadRootDir: session.browser.downloadRootDir,
				fileWorkspaceRoot: session.browser.fileWorkspaceRoot,
				previousFileSignatures: session.downloadedFileSignatures,
				previousNewFilePaths: session.downloadedNewFilePaths,
			});
			return downloadedFilesState;
		},
	);
	let workspaceFiles: ReturnType<typeof buildWorkspaceFilesPayload> = [];
	workspaceFiles = timeStateExtractionPhaseSync(
		{
			stepNumber: input.stepNumber,
			phase: "buildWorkspaceFilesPayload",
			detail: () => `workspace_files=${workspaceFiles.length}`,
		},
		() => {
			workspaceFiles = buildWorkspaceFilesPayload({
				fileWorkspaceRoot: session.browser.fileWorkspaceRoot,
				downloadRootDir: session.browser.downloadRootDir,
			});
			return workspaceFiles;
		},
	);
	let authUsernameOrEmail: string | undefined;
	authUsernameOrEmail = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "getAuthUsernameForContext",
			detail: () =>
				`auth_context=${authUsernameOrEmail ? "available" : "none"}`,
		},
		async () => {
			authUsernameOrEmail = await getAuthUsernameForContext({
				session,
				currentUrl,
			});
			return authUsernameOrEmail;
		},
	);

	let forceMemoryContent = input.forceMemoryContent;
	let forcedMemoryBarrierFailed = false;
	if (forceMemoryContent) {
		const extractionBarrier =
			await session.dataExtractionCoordinator.waitForAllAndFlush({
				filePath: session.extractDataMemoryFile,
			});
		session.previousToolObservations.push(...extractionBarrier.observations);
		if (extractionBarrier.errors.length > 0) {
			promptInteractionErrors.push(...extractionBarrier.errors);
			forceMemoryContent = false;
			forcedMemoryBarrierFailed = true;
		}
	}
	promptInteractionErrors.push(
		...session.dataExtractionCoordinator.drainErrors(),
	);

	const projectionHistoryContext = cumulativeProjectionHistoryEnabled
		? resolveProjectionHistoryContext({
				previousProjection: previousCanonicalProjection,
				currentProjection: projection,
				maxDiffToFullRatio: Number.POSITIVE_INFINITY,
			})
		: undefined;
	let history: ReturnType<typeof buildHistoryMessagesFromFullStepHistory> = [];
	history = timeStateExtractionPhaseSync(
		{
			stepNumber: input.stepNumber,
			phase: "buildHistoryMessages",
			detail: () => `history_messages=${history.length}`,
		},
		() => {
			history = buildHistoryMessagesFromFullStepHistory(
				input.stepsHistory,
				executorPromptOptions,
				{
					omitProjectionContext: false,
				},
			);
			return history;
		},
	);
	const payloadState = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "buildStepPayload",
			detail: () =>
				`interaction_errors=${promptInteractionErrors.length} open_tabs=${openTabs.length} newly_opened_tabs=${newlyOpenedTabs.length}`,
		},
		async () =>
			deps.buildStepPayload({
				task: input.userTask,
				checklistForPayload: formatChecklistForPrompt(session.activeChecklist),
				url: currentUrl,
				previousInteractionErrors: promptInteractionErrors,
				previousToolObservations: session.previousToolObservations,
				projection: projectionHistoryContext?.projection ?? projection,
				currentTab,
				openTabs: openTabs.map((tab) => deps.formatTabTitle(tab)),
				newlyOpenedTabs: newlyOpenedTabs.map((tab) => deps.formatTabTitle(tab)),
				autoTabSwitchNote,
				downloadedFiles: downloadedFilesState.downloadedFiles,
				workspaceFiles,
				authUsernameOrEmail,
				pendingMemoryRead: forcedMemoryBarrierFailed
					? false
					: session.pendingMemoryRead,
				forceMemoryContent,
				memoryFile: session.memoryFile,
				extractDataMemoryFile: session.extractDataMemoryFile,
				pinnedMemoryContent: session.pinnedMemoryContent,
				currentPageScreenshotIncludedAsImagePart: Boolean(
					preStepScreenshotDataUrl,
				),
				validatorFeedback: input.validatorFeedback,
				modelOutputErrors: input.modelOutputErrors,
			}),
	);
	if (projectionHistoryContext) {
		payloadState.payload.projectionContextMode =
			projectionHistoryContext.mode === "full" ? "reset" : "delta";
	}
	if (input.finalizationInstruction) {
		payloadState.payload.remainingSteps = 0;
		payloadState.payload.maxStepFinalization = true;
	}
	session.pendingMemoryRead = payloadState.pendingMemoryRead;
	session.downloadedFileSignatures = downloadedFilesState.fileSignatures;
	session.downloadedNewFilePaths = downloadedFilesState.newFilePaths;
	const firstTokenEstimateStartedAt = Date.now();
	payloadState.payload.latestUserPromptTokenCount = deps.estimateTokenCount(
		yaml.dump(payloadState.payload),
	);
	logStateExtractionPhase({
		stepNumber: input.stepNumber,
		phase: "estimateTokenCount:initial",
		durationMs: Date.now() - firstTokenEstimateStartedAt,
		detail: `tokens=${payloadState.payload.latestUserPromptTokenCount}`,
	});

	const fittedPrompt = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "fitStepPromptToBudget",
			detail: () =>
				`history_messages=${history.length} image_part=${preStepScreenshotDataUrl ? "yes" : "no"}`,
		},
		async () =>
			fitStepPromptToBudget({
				llmOptions: input.llmOptions,
				systemPrompt: deps.getExecutorSystem({
					currentUrl,
					...executorPromptOptions,
				}),
				history,
				payload: payloadState.payload,
				buildStepMessages: (params) => {
					const baseMessages = deps.buildStepMessages(params);
					if (!input.finalizationInstruction) {
						return baseMessages;
					}
					return buildMaxStepFinalizationMessages({
						messages: baseMessages,
						finalizationInstruction: input.finalizationInstruction,
					});
				},
				estimateTokenCount: deps.estimateTokenCount,
				currentPageScreenshotDataUrl: preStepScreenshotDataUrl || undefined,
				projectionHistoryContext: {
					enabled: cumulativeProjectionHistoryEnabled,
					canonicalProjection: projection,
				},
			}),
	);
	if (fittedPrompt.budgetReport.reductions.length > 0) {
		console.log(
			`[prompt-budget] stage=runAgent step=${input.stepNumber} ` +
				`initial_input_tokens=${fittedPrompt.budgetReport.initialInputTokens} ` +
				`final_input_tokens=${fittedPrompt.budgetReport.finalInputTokens} ` +
				`max_input_tokens=${fittedPrompt.budgetReport.maxInputTokens ?? "unbounded"} ` +
				`reductions=${fittedPrompt.budgetReport.reductions.join(",")}`,
		);
	}
	if (
		fittedPrompt.budgetReport.reductions.includes(
			"checkpoint_cumulative_projection_history",
		)
	) {
		for (const entry of input.stepsHistory) {
			stripProjectionContextFromHistoryPayload(entry.payload);
		}
	}
	payloadState.payload = fittedPrompt.payload;
	preStepScreenshotDataUrl = fittedPrompt.currentPageScreenshotDataUrl || "";
	const messages = fittedPrompt.messages;
	if (cumulativeProjectionHistoryEnabled) {
		const finalMode = payloadState.payload.projectionContextMode;
		const finalProjection =
			typeof payloadState.payload.projection === "string"
				? payloadState.payload.projection
				: "";
		const expectedPromptProjection =
			projectionHistoryContext &&
			finalMode ===
				(projectionHistoryContext.mode === "full" ? "reset" : "delta")
				? projectionHistoryContext.projection
				: projection;
		session.projectionHistory.pending = {
			canonicalProjection: projection,
			sourceHistoryLength: input.stepsHistory.length,
			canDiffFrom:
				(finalMode === "reset" || finalMode === "delta") &&
				finalProjection === expectedPromptProjection,
		};
	}

	session.previousStepTabs = openTabs;
	const latestUserPromptTokenCount = Number(
		payloadState.payload.latestUserPromptTokenCount ?? 0,
	);

	return {
		prompt: {
			messages,
			payload: payloadState.payload,
		},
		artifacts: {
			preStepScreenshotDataUrl: preStepScreenshotDataUrl || undefined,
			canonicalProjection: projection,
		},
		context: {
			current_url: currentUrl,
			open_tabs: openTabs.map((tab) => deps.formatTabTitle(tab)),
			current_tab: currentTab,
			valid_refs_count: validRefs.length,
			latest_user_prompt_token_count: latestUserPromptTokenCount,
			prompt_budget_reductions: [...fittedPrompt.budgetReport.reductions],
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeGeneratedActionsInput(input: unknown): unknown {
	if (Array.isArray(input)) {
		return input;
	}
	if (isRecord(input)) {
		if (Array.isArray(input.tools)) return input.tools;
		if (Array.isArray(input.actions)) return input.actions;
	}
	return input;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isStaleContextNodeError(message: string): boolean {
	return (
		message.includes("Could not find node with given id") ||
		message.includes("Node does not have a layout object") ||
		message.includes("Could not find object with given id")
	);
}

export async function browse(
	deps: CoreDeps,
	input: BrowseInput,
): Promise<BrowseResult> {
	const session = getSessionOrThrow(deps, input.port);
	const normalizedInput = normalizeGeneratedActionsInput(
		input.generatedActions,
	);
	const additionalInteractionErrors: string[] = [];
	const normalizedActions =
		input.generatedActionsAreNormalized && Array.isArray(normalizedInput)
			? {
					status: "accepted" as const,
					actions: normalizedInput as Action[],
					diagnostics: [] as [],
				}
			: deps.normalizeActionListWithDiagnostics(normalizedInput);
	const actions =
		normalizedActions.status === "accepted" ? normalizedActions.actions : [];
	logActionBoundary("browse_actions_received", {
		action_contract_status: normalizedActions.status,
		generated_actions_are_normalized:
			input.generatedActionsAreNormalized === true,
		generated_actions: normalizedInput,
		actions,
		normalization_diagnostics: normalizedActions.diagnostics,
	});
	for (const diagnostic of normalizedActions.diagnostics) {
		additionalInteractionErrors.push(`action_normalization: ${diagnostic}`);
	}

	let openTabs: Tab[] = session.previousStepTabs ?? [];
	try {
		openTabs = await deps.listTabs(session.browser);
	} catch (error) {
		additionalInteractionErrors.push(
			`context(open_tabs:before): ${toErrorMessage(error)}`,
		);
	}
	let currentUrlBeforeActions = "";
	try {
		currentUrlBeforeActions = await deps.getCurrentURL(session.browser);
	} catch {
		currentUrlBeforeActions = "";
	}
	const protectAuthContext = shouldProtectAuthContext(session);
	const domOptions = {
		omitHrefs: true,
		redactInputRefs: protectAuthContext
			? [...(session.authTakeover?.protectedRefs || [])]
			: [],
		redactPasswordInputs: protectAuthContext,
	};
	let projectionBeforeActions = session.projectionHistory.pending
		? session.projectionHistory.pending.canonicalProjection
		: input.pageProjection;
	if (actions.some((action) => action.type === "extract_data")) {
		try {
			projectionBeforeActions = await deps.getPageProjection(session.browser, {
				...domOptions,
				omitHrefs: false,
				preserveFullHrefs: true,
			});
		} catch (error) {
			additionalInteractionErrors.push(
				`context(projection:before_extract_data): ${toErrorMessage(error)}`,
			);
		}
	}

	let execution: Awaited<ReturnType<CoreDeps["executeActions"]>>;
	if (normalizedActions.status === "rejected") {
		execution = {
			pendingMemoryRead: false,
			interactionErrors: [],
			toolObservations: [],
			authTakeoverAttempts: [],
			returnedResult: undefined,
			userTakeover: undefined,
		};
	} else {
		try {
			execution = await deps.executeActions({
				b: session.browser,
				actions,
				openTabs,
				memoryFile: session.memoryFile,
				extractDataMemoryFile: session.extractDataMemoryFile,
				fileWorkspaceRoot: session.browser.fileWorkspaceRoot,
				userActionBehavior: deps.userActionBehavior,
				onUserActionRequired: deps.onUserActionRequired,
				requestAgentTakeover: deps.requestAgentTakeover,
				waitForAutomationPermission: deps.waitForAutomationPermission,
				stepNumber: input.stepNumber,
				currentUrl: currentUrlBeforeActions,
				userTask: input.userTask,
				pageProjection: projectionBeforeActions,
				dataExtractionLLMOptions: input.dataExtractionLLMOptions,
				estimateTokenCount: deps.estimateTokenCount,
				recordModelInvocation: input.recordModelInvocation,
				downloadedFiles: input.promptDownloadedFiles,
				workspaceFiles: input.promptWorkspaceFiles,
				memoryContentAvailable: input.memoryContentAvailable,
				extractDataResultsFromSnapshot: deps.extractDataResultsFromSnapshot,
				dataExtractionCoordinator: session.dataExtractionCoordinator,
				stepBaseIndex:
					typeof input.stepNumber === "number"
						? Math.max(0, input.stepNumber)
						: undefined,
				attemptAutomatedAuthTakeover: async (authInput) =>
					await attemptAutomatedAuthTakeover({
						deps,
						browser: session.browser,
						sessionAuth: session.authTakeover,
						stepBaseIndex: authInput.stepBaseIndex,
					}),
			});
		} catch (error) {
			if (input.allowFatalActionErrors) {
				throw error;
			}
			additionalInteractionErrors.push(
				`execute_actions: ${toErrorMessage(error)}`,
			);
			execution = {
				pendingMemoryRead: false,
				interactionErrors: [],
				toolObservations: [],
				authTakeoverAttempts: [],
				returnedResult: undefined,
				userTakeover: undefined,
			};
		}
	}

	session.pendingMemoryRead =
		session.pendingMemoryRead || execution.pendingMemoryRead;
	session.previousToolObservations = execution.toolObservations ?? [];
	let currentUrl = "";
	try {
		currentUrl = await deps.getCurrentURL(session.browser);
	} catch (error) {
		additionalInteractionErrors.push(
			`context(current_url): ${toErrorMessage(error)}`,
		);
	}

	let nextOpenTabs: Tab[] = openTabs;
	try {
		nextOpenTabs = await deps.listTabs(session.browser);
	} catch (error) {
		additionalInteractionErrors.push(
			`context(open_tabs:after): ${toErrorMessage(error)}`,
		);
	}

	let newlyOpenedTabs = deps.getNewlyOpenedTabs(
		session.previousStepTabs,
		nextOpenTabs,
	);
	let skippedBlankDownloadTab = false;
	if ((input.autoSwitchToNewTab ?? true) && newlyOpenedTabs.length > 0) {
		const firstNewTab = firstMeaningfulNewTab(newlyOpenedTabs);
		if (firstNewTab) {
			const currentTabTargetId =
				nextOpenTabs.find((tab) => tab.url === currentUrl)?.targetId ??
				session.browser.currentTargetId;
			if (currentTabTargetId !== firstNewTab.targetId) {
				console.log(
					`Auto-switching to first newly opened tab after actions: "${deps.formatTabTitle(firstNewTab)}"`,
				);
				await deps.switchTab(session.browser, firstNewTab.targetId);
				currentUrl = await deps.getCurrentURL(session.browser);
				nextOpenTabs = await deps.listTabs(session.browser);
				newlyOpenedTabs = deps.getNewlyOpenedTabs(
					session.previousStepTabs,
					nextOpenTabs,
				);
			}
		} else {
			const restored = await restoreSourceTabAfterBlankDownloadTab({
				deps,
				session,
				openTabs: nextOpenTabs,
				currentUrl,
				newlyOpenedTabs,
			});
			currentUrl = restored.currentUrl;
			skippedBlankDownloadTab = restored.restored;
			if (restored.restored) {
				nextOpenTabs = await deps.listTabs(session.browser);
				newlyOpenedTabs = deps.getNewlyOpenedTabs(
					session.previousStepTabs,
					nextOpenTabs,
				);
			}
		}
	}

	let currentTab = 0;
	try {
		currentTab = await deps.resolveCurrentTabIndex({
			b: session.browser,
			openTabs: nextOpenTabs,
			currentUrl,
		});
	} catch (error) {
		additionalInteractionErrors.push(
			`context(current_tab): ${toErrorMessage(error)}`,
		);
	}
	if (
		!Number.isInteger(currentTab) ||
		currentTab < 0 ||
		currentTab >= nextOpenTabs.length
	) {
		currentTab = 0;
	}
	if (!currentUrl) {
		currentUrl = nextOpenTabs[currentTab]?.url || nextOpenTabs[0]?.url || "";
	}
	let projection = "";
	let validRefs: string[] = [];
	try {
		projection = await deps.getPageProjection(session.browser, domOptions);
		validRefs = deps.extractValidRefs(projection);
	} catch (error) {
		const message = toErrorMessage(error);
		if (message.includes("bad refs") || message.includes("valid_refs")) {
			additionalInteractionErrors.push(`context(valid_refs): ${message}`);
		} else {
			additionalInteractionErrors.push(`context(projection): ${message}`);
		}
	}
	if (projection && validRefs.length === 0) {
		try {
			validRefs = deps.extractValidRefs(projection);
		} catch (error) {
			additionalInteractionErrors.push(
				`context(valid_refs): ${toErrorMessage(error)}`,
			);
		}
	}

	const downloadedFilesState = buildDownloadedFilesPayload({
		downloadDir: session.browser.downloadDir,
		downloadRootDir: session.browser.downloadRootDir,
		fileWorkspaceRoot: session.browser.fileWorkspaceRoot,
		previousFileSignatures: session.downloadedFileSignatures,
		previousNewFilePaths: session.downloadedNewFilePaths,
	});
	if (skippedBlankDownloadTab && downloadedFilesState.newFilePaths.size > 0) {
		additionalInteractionErrors.push(BLANK_DOWNLOAD_TAB_CONTEXT_NOTE);
	}
	const interactionErrors = [
		...execution.interactionErrors,
		...additionalInteractionErrors,
		...session.dataExtractionCoordinator.drainErrors(),
	];
	const normalizedUserTakeover = execution.userTakeover
		? {
				reason: execution.userTakeover.reason,
				category: normalizeUserTakeoverCategory({
					category: execution.userTakeover.category,
					reason: execution.userTakeover.reason,
				}),
			}
		: undefined;
	session.previousInteractionErrors = interactionErrors;
	session.previousStepTabs = nextOpenTabs;
	session.downloadedFileSignatures = downloadedFilesState.fileSignatures;
	session.downloadedNewFilePaths = downloadedFilesState.newFilePaths;

	return {
		execution: {
			pending_memory_read: execution.pendingMemoryRead,
			returned_result: execution.returnedResult,
			interaction_errors: interactionErrors,
			auth_takeover_attempts: execution.authTakeoverAttempts,
			user_takeover: normalizedUserTakeover,
		},
		context: {
			current_url: currentUrl,
			open_tabs: nextOpenTabs.map((tab) => deps.formatTabTitle(tab)),
			current_tab: currentTab,
			downloaded_files: downloadedFilesState.downloadedFiles,
			projection,
			valid_refs: validRefs,
		},
	};
}

export async function processStepModelOutput(
	deps: CoreDeps,
	input: ProcessModelStepOutputInput,
): Promise<ProcessModelStepOutputResult> {
	const downloadedFiles = Array.isArray(input.promptPayload.downloadedFiles)
		? input.promptPayload.downloadedFiles.filter(
				(entry): entry is string => typeof entry === "string",
			)
		: [];
	const processedStep = processModelStepOutput(input.rawStepOutput);
	if (processedStep.actionContractStatus === "rejected") {
		throw new ModelStepActionContractError(
			processedStep.normalizationDiagnostics,
		);
	}
	const step = canonicalizeStepDownloadedFilePaths({
		step: processedStep.step,
		downloadedFiles,
	});
	const normalizedChecklistUpdate = normalizeChecklistUpdate(
		step.checklistUpdate,
		input.sessionChecklist ?? [],
	);
	step.checklistUpdate = normalizedChecklistUpdate;
	if (input.sessionChecklist) {
		applyChecklistUpdate(input.sessionChecklist, normalizedChecklistUpdate);
	}
	if (input.allowModelResultCompletion === false && step.done) {
		step.done = false;
		delete step.result;
	}
	const assistant = formatStepForPrompt(step);
	const priorHistoryMessages = buildHistoryMessagesFromFullStepHistory(
		input.stepsHistory,
	);
	const historyEntry: StepHistoryEntry = {
		payload: stripPayloadForHistory({
			payload: input.promptPayload,
			cumulativeProjectionHistoryEnabled:
				shouldUseCumulativeProjectionHistory(configFeatureFlags),
			projectionContextMode:
				input.promptPayload.projectionContextMode === "reset" ||
				input.promptPayload.projectionContextMode === "delta"
					? input.promptPayload.projectionContextMode
					: undefined,
			stepsHistory: input.stepsHistory,
		}),
		assistant,
		...(shouldIncludeExecutorReasoningHistory() && input.reasoningTokens?.trim()
			? { reasoningTokens: input.reasoningTokens.trim() }
			: {}),
	};
	input.stepsHistory.push(historyEntry);

	const successVerification =
		step.done && deps.defaultSuccessVerifierLLMOptions
			? await (deps.verifyTaskSuccess ?? defaultVerifyTaskSuccess)({
					task:
						typeof input.promptPayload.task === "string"
							? input.promptPayload.task
							: "",
					executedSteps: input.stepsHistory.length,
					maxSteps:
						typeof input.promptPayload.maxSteps === "number"
							? input.promptPayload.maxSteps
							: undefined,
					finalStep: step,
					finalPromptPayload: input.promptPayload,
					checklist: input.sessionChecklist,
					purpose: input.verificationPurpose,
					contextMode: input.validatorContext,
					historyMessages: priorHistoryMessages,
					llmOptions: deps.defaultSuccessVerifierLLMOptions,
					estimateTokenCount: deps.estimateTokenCount,
					caller: "processStepModelOutput:verifySuccess",
					onTrace: input.recordModelInvocation,
				})
			: undefined;
	return {
		step,
		history_entry: historyEntry,
		successful: successVerification?.success === true,
		successVerification,
	};
}

export async function processModelOutputAndBrowse(
	deps: CoreDeps,
	port: number,
	input: StepInputByMode<"process_model_step_output">,
): Promise<{
	step: ProcessModelStepOutputResult["step"];
	successful: boolean;
	successVerification?: ProcessModelStepOutputResult["successVerification"];
	browse?: BrowseResult;
}> {
	const preprocessResult = await processStepModelOutput(deps, {
		...input,
		allowModelResultCompletion: false,
	});
	if (preprocessResult.step.done) {
		return {
			step: preprocessResult.step,
			successful: preprocessResult.successful,
			successVerification: preprocessResult.successVerification,
		};
	}

	const result = await browse(deps, {
		port,
		generatedActions: preprocessResult.step.actions as Action[],
		generatedActionsAreNormalized: true,
		userTask:
			typeof input.promptPayload.task === "string"
				? input.promptPayload.task
				: undefined,
		pageProjection:
			typeof input.promptPayload.projection === "string"
				? input.promptPayload.projection
				: undefined,
		dataExtractionLLMOptions: input.dataExtractionLLMOptions,
		recordModelInvocation: input.recordModelInvocation,
		stepNumber: input.stepNumber,
		allowFatalActionErrors: input.allowFatalActionErrors,
		autoSwitchToNewTab: input.autoSwitchToNewTab,
		promptDownloadedFiles: Array.isArray(input.promptPayload.downloadedFiles)
			? input.promptPayload.downloadedFiles.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: [],
		promptWorkspaceFiles: Array.isArray(input.promptPayload.workspaceFiles)
			? input.promptPayload.workspaceFiles.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: [],
		memoryContentAvailable:
			typeof input.promptPayload.memoryContent === "string",
	});

	if (typeof result.execution.returned_result === "string") {
		preprocessResult.step.done = true;
		preprocessResult.step.result = result.execution.returned_result;
		const successVerification = deps.defaultSuccessVerifierLLMOptions
			? await (deps.verifyTaskSuccess ?? defaultVerifyTaskSuccess)({
					task:
						typeof input.promptPayload.task === "string"
							? input.promptPayload.task
							: "",
					executedSteps: input.stepsHistory.length,
					maxSteps:
						typeof input.promptPayload.maxSteps === "number"
							? input.promptPayload.maxSteps
							: undefined,
					finalStep: preprocessResult.step,
					finalPromptPayload: input.promptPayload,
					checklist: input.sessionChecklist,
					purpose: input.verificationPurpose,
					contextMode: input.validatorContext,
					historyMessages: buildHistoryMessagesFromFullStepHistory(
						input.stepsHistory,
					),
					llmOptions: deps.defaultSuccessVerifierLLMOptions,
					estimateTokenCount: deps.estimateTokenCount,
					caller: "processModelOutputAndBrowse:verifyMemoryReturnResults",
					onTrace: input.recordModelInvocation,
				})
			: undefined;
		return {
			step: preprocessResult.step,
			successful: successVerification?.success === true,
			successVerification,
			browse: result,
		};
	}

	return {
		step: preprocessResult.step,
		successful: false,
		browse: result,
	};
}

export async function step(
	deps: CoreDeps,
	input: StepInputByMode<"create_prompt_for_step">,
): Promise<StepResultByMode<"create_prompt_for_step">>;

export async function step(
	deps: CoreDeps,
	input: StepInputByMode<"browse">,
): Promise<StepResultByMode<"browse">>;

export async function step(
	deps: CoreDeps,
	input: StepInputByMode<"process_model_step_output">,
): Promise<StepResultByMode<"process_model_step_output">>;

export async function step(
	deps: CoreDeps,
	input: StepInput,
): Promise<StepResult> {
	if (input.mode === "create_prompt_for_step") {
		const result = await createPromptForStep(deps, input);
		return { mode: input.mode, ...result };
	}

	if (input.mode === "process_model_step_output") {
		const result = await processStepModelOutput(deps, input);
		return { mode: input.mode, ...result };
	}

	const result = await browse(deps, input);
	return { mode: input.mode, ...result };
}
