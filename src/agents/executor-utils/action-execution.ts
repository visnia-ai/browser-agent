import * as fs from "fs";
import * as vm from "node:vm";
import yaml from "js-yaml";
import type { Browser, Tab } from "../../browser/types.js";
import {
	clickWithFileChooserGuard,
	downloadCurrentFile,
	consumePrintRequestsAndSavePdfs,
	dropdownSelect,
	isSupportedInBrowserNavigateUrl,
	longPress,
	pasteFile,
	scroll,
	type as typeText,
	execJS,
	navigate,
	switchTab,
	uploadFiles,
} from "../../browser/browser.js";
import { configFeatureFlags } from "../../config-feature-flags.js";
import type {
	Action,
	AuthTakeoverAttemptEvent,
	ExecuteActionsResult,
	ExecutorResultItem,
	LLMOptions,
	OpenAIPromptCacheRequest,
	StageModelInvocationTrace,
} from "../types.js";
import type {
	BrowserAgentTakeoverRequest,
	BrowserAgentTakeoverResult,
} from "../../core/types.js";
import {
	normalizeUserTakeoverCategory,
	type UserTakeoverCategory,
} from "../../user-action-types.js";
import { extractDataResultsFromSnapshot } from "../data-extraction.js";
import {
	appendMemoryFile,
	appendMemoryResultItems,
	clearMemoryFile,
	readMemoryFile,
} from "./memory-file.js";
import { extractMemoryResults } from "./memory-results.js";
import { readLocalFile } from "./read-file.js";
import { extractSemanticProjectionRegion } from "./semantic-projection-subtree.js";
import { DataExtractionCoordinator } from "./data-extraction-coordinator.js";
import {
	validateUserTakeoverReason,
	waitForUserTakeoverSignal,
} from "./user-takeover.js";
import { formatTabTitle } from "./step-context.js";
import type { CustomToolRegistry } from "../../custom-tools.js";

export interface StepPartTimingEntry {
	part: string;
	durationMs: number;
}

const MAX_EVALUATE_OBSERVATION_CHARACTERS = 4_000;
const CUSTOM_TOOL_TIMEOUT_MS = 30_000;

interface CustomToolMemoryReadResult {
	memory: string;
	memory_result: string;
}

interface CustomToolRuntimeContext {
	args: Record<string, unknown>;
	cdp: Browser["client"];
	memory_read: () => Promise<CustomToolMemoryReadResult>;
	memory_write: (content: string) => void;
	memory_result_write: (items: unknown) => Promise<void>;
	return_results: (results?: unknown) => Promise<never>;
}

const CUSTOM_TOOL_RETURNED_RESULTS = Symbol("custom tool returned results");

function formatCustomToolObservation(name: string, value: unknown): string {
	const serialized = JSON.stringify(value);
	const truncated = serialized.length > MAX_EVALUATE_OBSERVATION_CHARACTERS;
	const visible = truncated
		? serialized.slice(0, MAX_EVALUATE_OBSERVATION_CHARACTERS)
		: serialized;
	return `${name} result (${serialized.length} chars${truncated ? ", truncated" : ""}): ${visible}`;
}

async function executeCustomTool(params: {
	name: string;
	customTools: CustomToolRegistry;
	context: CustomToolRuntimeContext;
	didReturnResults: () => boolean;
}): Promise<unknown | typeof CUSTOM_TOOL_RETURNED_RESULTS> {
	const definition = params.customTools.get(params.name);
	if (!definition)
		throw new Error(`custom tool \"${params.name}\" is unavailable`);
	const context = vm.createContext({
		__browserAgentCustomToolContext: params.context,
	});
	const script = new vm.Script(
		`(async () => {
		const tool = (${definition.javascript});
		if (typeof tool !== "function") throw new Error("custom tool source must evaluate to a function");
		return await tool(__browserAgentCustomToolContext);
	})()`,
		{
			filename: `browser-agent-custom-tool:${definition.name}`,
		},
	);
	const execution = Promise.resolve(
		script.runInContext(context, { timeout: CUSTOM_TOOL_TIMEOUT_MS }),
	);
	let timeout: NodeJS.Timeout | undefined;
	try {
		const value = await Promise.race([
			execution,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() =>
						reject(new Error(`Timed out after ${CUSTOM_TOOL_TIMEOUT_MS}ms`)),
					CUSTOM_TOOL_TIMEOUT_MS,
				);
			}),
		]);
		if (params.didReturnResults()) return CUSTOM_TOOL_RETURNED_RESULTS;
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new Error("custom tool must return a JSON-serializable value");
		}
		return JSON.parse(serialized);
	} catch (error) {
		if (params.didReturnResults()) return CUSTOM_TOOL_RETURNED_RESULTS;
		const rawMessage =
			error instanceof Error ? error.message : "custom tool execution failed";
		throw new Error(rawMessage.split("\n", 1)[0].slice(0, 1_000));
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function formatEvaluateObservation(result: string): string {
	const truncated = result.length > MAX_EVALUATE_OBSERVATION_CHARACTERS;
	const visibleResult = truncated
		? result.slice(0, MAX_EVALUATE_OBSERVATION_CHARACTERS)
		: result;
	return `evaluate result (${result.length} chars${truncated ? ", truncated" : ""}): ${JSON.stringify(visibleResult)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return Math.trunc(parsed);
		}
	}
	return undefined;
}

function toStringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toAuthTakeoverStage(value: unknown): "probe" | "result" | undefined {
	return value === "probe" || value === "result" ? value : undefined;
}

function formatAuthTakeoverAttemptEvent(
	event: AuthTakeoverAttemptEvent,
): string {
	const parts = [
		`step_kind=${event.step_kind}`,
		`attempt_index=${event.attempt_index}`,
		`stage=${event.stage ?? "n/a"}`,
		`decision=${event.decision ?? "n/a"}`,
		`action=${event.action ?? "n/a"}`,
		`result=${event.result ?? "n/a"}`,
		`outcome=${event.outcome ?? "n/a"}`,
	];
	if (typeof event.step === "number") {
		parts.unshift(`step=${event.step}`);
	}
	return parts.join(" ");
}

function canConsumePrintRequests(browser: Browser): boolean {
	const candidate = browser as Partial<Browser>;
	return (
		typeof candidate.Runtime?.evaluate === "function" &&
		typeof candidate.Page?.printToPDF === "function"
	);
}

function logAuthTakeoverAttemptEvent(event: AuthTakeoverAttemptEvent): void {
	console.log(`    -> ${formatAuthTakeoverAttemptEvent(event)}`);
}

function appendAgentTakeoverMemory(params: {
	memoryFile: string;
	content: string;
}): void {
	const content = params.content.trim();
	if (!content) {
		return;
	}
	let existing = "";
	try {
		existing = fs.readFileSync(params.memoryFile, "utf-8").trim();
	} catch {
		existing = "";
	}
	const block = ["OS-prepared context:", content].join("\n");
	fs.writeFileSync(
		params.memoryFile,
		existing ? `${existing}\n\n${block}\n` : `${block}\n`,
		"utf-8",
	);
}

function normalizeAgentTakeoverFileEntries(entries: string[] = []): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		let normalized = entry.trim();
		if (normalized.startsWith("[NEW] ")) {
			normalized = normalized.slice("[NEW] ".length).trim();
		}
		if (normalized.startsWith("[DOWNLOADING] ")) {
			continue;
		}
		if (!normalized.startsWith("./")) {
			continue;
		}
		if (normalized.split("/").some((part) => part === "..")) {
			continue;
		}
		if (!seen.has(normalized)) {
			seen.add(normalized);
			out.push(normalized);
		}
	}
	return out;
}

function formatExplicitResults(
	results: ExecutorResultItem[],
	downloadedFiles: string[] = [],
): string {
	if (results.length === 0) {
		throw new Error("return_results result list must not be empty");
	}
	const availableDownloads = new Set(
		normalizeAgentTakeoverFileEntries(downloadedFiles),
	);
	const normalized = results.map((item, index) => {
		const link = item.link.trim();
		const summary = item.summary.trim();
		if (!link || !summary) {
			throw new Error(
				`return_results item ${index + 1} requires non-empty link and summary`,
			);
		}
		const downloadedFilePath = item.downloaded_file_path?.trim();
		if (
			downloadedFilePath &&
			(!downloadedFilePath.startsWith("./") ||
				!availableDownloads.has(downloadedFilePath))
		) {
			throw new Error(
				`return_results item ${index + 1} downloaded_file_path must match downloadedFiles`,
			);
		}
		return {
			link,
			summary,
			...(downloadedFilePath
				? { downloaded_file_path: downloadedFilePath }
				: {}),
		};
	});
	return yaml.dump(normalized, { lineWidth: -1 }).trim();
}

function normalizeCustomToolResultItems(
	value: unknown,
	options: { allowDownloadedFilePath: boolean },
): ExecutorResultItem[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("result items must be a non-empty array");
	}
	return value.map((entry, index) => {
		if (!isRecord(entry)) {
			throw new Error(`result item ${index + 1} must be an object`);
		}
		const supportedKeys = options.allowDownloadedFilePath
			? new Set(["link", "summary", "downloaded_file_path"])
			: new Set(["link", "summary"]);
		for (const key of Object.keys(entry)) {
			if (!supportedKeys.has(key)) {
				throw new Error(`result item ${index + 1}.${key} is not supported`);
			}
		}
		if (typeof entry.link !== "string" || typeof entry.summary !== "string") {
			throw new Error(
				`result item ${index + 1} requires string link and summary`,
			);
		}
		if (!entry.link.trim() || !entry.summary.trim()) {
			throw new Error(
				`result item ${index + 1} requires non-empty link and summary`,
			);
		}
		if (
			entry.downloaded_file_path !== undefined &&
			typeof entry.downloaded_file_path !== "string"
		) {
			throw new Error(
				`result item ${index + 1}.downloaded_file_path must be a string`,
			);
		}
		return {
			link: entry.link,
			summary: entry.summary,
			...(typeof entry.downloaded_file_path === "string"
				? { downloaded_file_path: entry.downloaded_file_path }
				: {}),
		};
	});
}

function normalizeAuthTakeoverAttemptEvent(
	value: unknown,
	params: {
		stepBaseIndex?: number;
		fallbackAttemptIndex: number;
	} = { fallbackAttemptIndex: 0 },
): AuthTakeoverAttemptEvent | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const attemptIndex =
		toFiniteInteger(value.attempt_index) ??
		toFiniteInteger(value.attempt) ??
		toFiniteInteger(value.index) ??
		(value.step_kind === "auth_takeover_attempt" ||
		typeof value.decision === "string" ||
		typeof value.action === "string" ||
		typeof value.result === "string" ||
		typeof value.outcome === "string" ||
		typeof value.reason === "string" ||
		typeof value.message === "string"
			? params.fallbackAttemptIndex > 0
				? params.fallbackAttemptIndex
				: 1
			: undefined);
	if (!attemptIndex || attemptIndex < 1) {
		return undefined;
	}
	const step =
		toFiniteInteger(value.step) ??
		toFiniteInteger(value.step_number) ??
		(typeof params.stepBaseIndex === "number"
			? params.stepBaseIndex + attemptIndex
			: undefined);
	const event: AuthTakeoverAttemptEvent = {
		step_kind: "auth_takeover_attempt",
		attempt_index: attemptIndex,
		...(typeof step === "number" ? { step } : {}),
	};
	if (Array.isArray(value.messages)) {
		event.messages = value.messages;
	}
	const tokenUsageValue = isRecord(value.token_usage)
		? value.token_usage
		: isRecord(value.tokenUsage)
			? value.tokenUsage
			: undefined;
	if (tokenUsageValue) {
		const inputTokens = toFiniteInteger(tokenUsageValue.input_tokens);
		const outputTokens = toFiniteInteger(tokenUsageValue.output_tokens);
		const totalTokens = toFiniteInteger(tokenUsageValue.total_tokens);
		const cachedInputTokens =
			toFiniteInteger(tokenUsageValue.cached_input_tokens) ?? 0;
		const cacheWriteTokens =
			toFiniteInteger(tokenUsageValue.cache_write_tokens) ?? 0;
		const timeToFirstTokenMs = toFiniteInteger(
			tokenUsageValue.time_to_first_token_ms,
		);
		const generationTimeMs = toFiniteInteger(
			tokenUsageValue.generation_time_ms,
		);
		if (
			typeof inputTokens === "number" &&
			typeof outputTokens === "number" &&
			typeof totalTokens === "number"
		) {
			event.token_usage = {
				input_tokens: inputTokens,
				cached_input_tokens: cachedInputTokens,
				cache_write_tokens: cacheWriteTokens,
				output_tokens: outputTokens,
				total_tokens: totalTokens,
				...(typeof timeToFirstTokenMs === "number"
					? {
							time_to_first_token_ms: timeToFirstTokenMs,
						}
					: {}),
				...(typeof generationTimeMs === "number"
					? {
							generation_time_ms: generationTimeMs,
						}
					: {}),
			};
		}
	}
	const decision =
		toStringValue(value.decision) ?? toStringValue(value.decisionAction);
	const action =
		toStringValue(value.action) ?? toStringValue(value.decisionAction);
	const result = toStringValue(value.result);
	const outcome = toStringValue(value.outcome);
	const reason = toStringValue(value.reason);
	const message = toStringValue(value.message);
	const stage = toStringValue(value.stage);
	const currentUrl =
		toStringValue(value.current_url) ?? toStringValue(value.currentUrl);
	const maxAttempts =
		toFiniteInteger(value.max_attempts) ?? toFiniteInteger(value.maxAttempts);
	if (decision) event.decision = decision;
	if (action) event.action = action;
	if (result) event.result = result;
	if (outcome) event.outcome = outcome;
	if (typeof value.handled === "boolean") event.handled = value.handled;
	if (reason) event.reason = reason;
	if (message) event.message = message;
	const normalizedStage = toAuthTakeoverStage(stage);
	if (normalizedStage) event.stage = normalizedStage;
	if (currentUrl) event.current_url = currentUrl;
	if (typeof maxAttempts === "number") event.max_attempts = maxAttempts;
	return event;
}

function normalizeAuthTakeoverAttempts(
	value: unknown,
	stepBaseIndex?: number,
): AuthTakeoverAttemptEvent[] {
	if (Array.isArray(value)) {
		return value
			.map((entry, index) =>
				normalizeAuthTakeoverAttemptEvent(entry, {
					stepBaseIndex,
					fallbackAttemptIndex: index + 1,
				}),
			)
			.filter((entry): entry is AuthTakeoverAttemptEvent => Boolean(entry));
	}
	if (!isRecord(value)) {
		return [];
	}
	const candidateKeys = [
		"traceEntries",
		"authTakeoverAttempts",
		"auth_takeover_attempts",
		"attempts",
		"traces",
		"trace",
		"events",
	];
	for (const key of candidateKeys) {
		const candidate = value[key];
		if (!Array.isArray(candidate)) {
			continue;
		}
		return candidate
			.map((entry, index) =>
				normalizeAuthTakeoverAttemptEvent(entry, {
					stepBaseIndex,
					fallbackAttemptIndex: index + 1,
				}),
			)
			.filter((entry): entry is AuthTakeoverAttemptEvent => Boolean(entry));
	}
	const directEvent = normalizeAuthTakeoverAttemptEvent(value, {
		stepBaseIndex,
		fallbackAttemptIndex:
			typeof value.attempt_index === "number" ||
			typeof value.attempt === "number"
				? 1
				: 0,
	});
	if (directEvent) {
		return [directEvent];
	}
	return [];
}

/** Execute a list of actions and return state changes */
export async function executeActions(params: {
	b: Browser;
	actions: Action[];
	openTabs: Tab[];
	memoryFile: string;
	extractDataMemoryFile?: string;
	fileWorkspaceRoot?: string;
	userActionBehavior?: "block" | "return" | "callback";
	onUserActionRequired?: (input: {
		kind: "browser_user_takeover";
		reason: string;
		category?: UserTakeoverCategory;
	}) => Promise<void>;
	requestAgentTakeover?: (
		input: BrowserAgentTakeoverRequest,
	) => Promise<BrowserAgentTakeoverResult>;
	attemptAutomatedAuthTakeover?: (input: {
		stepBaseIndex?: number;
	}) => Promise<{ handled: boolean } & Record<string, unknown>>;
	waitForAutomationPermission?: () => Promise<void>;
	stepTimings?: StepPartTimingEntry[];
	timingEnabled?: boolean;
	stepNumber?: number;
	stepBaseIndex?: number;
	currentUrl?: string;
	userTask?: string;
	pageProjection?: string;
	dataExtractionLLMOptions?: LLMOptions;
	dataExtractionPromptCache?: OpenAIPromptCacheRequest;
	estimateTokenCount?: (text: string) => number;
	recordModelInvocation?: (trace: StageModelInvocationTrace) => void;
	downloadedFiles?: string[];
	workspaceFiles?: string[];
	memoryContentAvailable?: boolean;
	extractDataResultsFromSnapshot?: typeof extractDataResultsFromSnapshot;
	dataExtractionCoordinator?: DataExtractionCoordinator;
	customTools?: CustomToolRegistry;
}): Promise<ExecuteActionsResult> {
	let pendingMemoryRead = false;
	let returnedResult: string | undefined;
	let pendingUserTakeover = false;
	let dataExtractionBarrierFailed = false;
	let userTakeoverReason: string | undefined;
	let userTakeoverCategory: UserTakeoverCategory | undefined;
	const interactionErrors: string[] = [];
	const toolObservations: string[] = [];
	const authTakeoverAttempts: AuthTakeoverAttemptEvent[] = [];
	const extractDataMemoryFile =
		params.extractDataMemoryFile ?? params.memoryFile;
	const dataExtractionCoordinator =
		params.dataExtractionCoordinator ?? new DataExtractionCoordinator();
	const agentTakeoverAction = params.actions.find(
		(action) => action.type === "agent_takeover",
	);
	const candidateActions = agentTakeoverAction
		? [agentTakeoverAction]
		: params.actions;
	const actions = candidateActions;
	const hasResultExtractionBeforeNextBarrier = (
		startIndex: number,
	): boolean => {
		for (let index = startIndex + 1; index < actions.length; index++) {
			const candidate = actions[index];
			if (
				candidate.type === "memory_read" ||
				candidate.type === "return_results" ||
				(candidate.type === "memory_clear" && candidate.target !== "memory")
			) {
				return false;
			}
			if (candidate.type === "extract_data") {
				return true;
			}
		}
		return false;
	};
	const flushCustomToolResultMemory = async (): Promise<void> => {
		const barrier = await dataExtractionCoordinator.waitForAllAndFlush({
			filePath: extractDataMemoryFile,
		});
		toolObservations.push(...barrier.observations);
		if (barrier.errors.length > 0) {
			dataExtractionBarrierFailed = true;
			throw new Error(barrier.errors.join("; "));
		}
	};

	for (const [actionIndex, action] of actions.entries()) {
		await params.waitForAutomationPermission?.();
		const actionTimingPart = `action_${actionIndex + 1}_${action.type}`;
		const actionStartedAt = Date.now();
		try {
			switch (action.type) {
				case "custom_tool": {
					if (!params.customTools) {
						throw new Error("custom tools are unavailable");
					}
					console.log(
						`    -> ${action.name}(${JSON.stringify(action.arguments)})`,
					);
					let customToolReturnedResults = false;
					const ensureCustomToolNotCompleted = () => {
						if (customToolReturnedResults) {
							throw new Error(
								"return_results already completed this custom tool",
							);
						}
					};
					const context: CustomToolRuntimeContext = Object.freeze({
						args: Object.freeze({ ...action.arguments }),
						cdp: params.b.client,
						memory_read: async () => {
							ensureCustomToolNotCompleted();
							await flushCustomToolResultMemory();
							pendingMemoryRead = true;
							return Object.freeze({
								memory: readMemoryFile(params.memoryFile).trim(),
								memory_result: readMemoryFile(extractDataMemoryFile).trim(),
							});
						},
						memory_write: (content: string) => {
							ensureCustomToolNotCompleted();
							if (typeof content !== "string") {
								throw new Error("memory_write content must be a string");
							}
							appendMemoryFile({ filePath: params.memoryFile, content });
						},
						memory_result_write: async (items: unknown) => {
							ensureCustomToolNotCompleted();
							const normalized = normalizeCustomToolResultItems(items, {
								allowDownloadedFilePath: false,
							});
							await flushCustomToolResultMemory();
							appendMemoryResultItems({
								filePath: extractDataMemoryFile,
								items: normalized.map(({ link, summary }) => ({
									link: link.trim(),
									summary: summary.trim(),
								})),
							});
							pendingMemoryRead = true;
						},
						return_results: async (results?: unknown): Promise<never> => {
							ensureCustomToolNotCompleted();
							let nextResult: string;
							if (results !== undefined) {
								nextResult = formatExplicitResults(
									normalizeCustomToolResultItems(results, {
										allowDownloadedFilePath: true,
									}),
									params.downloadedFiles,
								);
							} else {
								await flushCustomToolResultMemory();
								nextResult = extractMemoryResults(
									readMemoryFile(extractDataMemoryFile),
								);
							}
							returnedResult = nextResult;
							customToolReturnedResults = true;
							throw new Error("return_results completed");
						},
					});
					const customResult = await executeCustomTool({
						name: action.name,
						customTools: params.customTools,
						context,
						didReturnResults: () => customToolReturnedResults,
					});
					if (customResult !== CUSTOM_TOOL_RETURNED_RESULTS) {
						toolObservations.push(
							formatCustomToolObservation(action.name, customResult),
						);
					}
					break;
				}
				case "click":
					console.log(`    -> click(ref=${action.ref})`);
					await clickWithFileChooserGuard({
						browser: params.b,
						ref: action.ref,
					});
					break;
				case "long_press":
					console.log(
						`    -> long_press(ref=${action.ref}, durationMs=${action.durationMs ?? 3000})`,
					);
					await longPress(params.b, action.ref, action.durationMs);
					break;
				case "type":
					console.log(
						`    -> type(ref=${action.ref}, "${action.text}", enter=${Boolean(action.enter)})`,
					);
					await typeText(
						params.b,
						action.ref,
						action.text,
						Boolean(action.enter),
					);
					break;
				case "scroll": {
					if (typeof action.ref !== "string" || !action.ref.trim()) {
						throw new Error(
							'scroll requires a non-empty "ref" for the target element',
						);
					}
					const deltaXRaw = action.deltaX;
					const deltaYRaw = action.deltaY;
					const hasDeltaX =
						typeof deltaXRaw === "number" && Number.isFinite(deltaXRaw);
					const hasDeltaY =
						typeof deltaYRaw === "number" && Number.isFinite(deltaYRaw);
					if (!hasDeltaX && !hasDeltaY) {
						throw new Error(
							'scroll requires at least one finite delta axis ("deltaX" or "deltaY")',
						);
					}
					const deltaX = hasDeltaX ? deltaXRaw : 0;
					const deltaY = hasDeltaY ? deltaYRaw : 0;
					if (deltaX === 0 && deltaY === 0) {
						throw new Error("scroll requires at least one non-zero delta axis");
					}
					console.log(
						`    -> scroll(ref=${action.ref}, deltaX=${deltaX}, deltaY=${deltaY})`,
					);
					await scroll(params.b, action.ref, deltaX, deltaY);
					break;
				}
				case "evaluate":
					if (typeof action.script !== "string" || !action.script.trim()) {
						throw new Error(
							'evaluate tool call requires a non-empty "script" string',
						);
					}
					console.log(
						`    -> evaluate(script="${action.script.slice(0, 150)}${action.script.length > 150 ? "..." : ""}")`,
					);
					const evaluateResult = await execJS(params.b, action.script);
					if (evaluateResult.startsWith("ERROR:")) {
						throw new Error(evaluateResult.slice("ERROR:".length).trim());
					}
					console.log(
						`       [evaluate] result="${evaluateResult.slice(0, 150)}${evaluateResult.length > 150 ? "..." : ""}"`,
					);
					toolObservations.push(
						formatEvaluateObservation(evaluateResult),
					);
					break;
				case "dropdown_select":
					if (typeof action.ref !== "string" || !action.ref.trim()) {
						throw new Error(
							'dropdown_select requires a non-empty "ref" for the select element',
						);
					}
					if (typeof action.value !== "string") {
						throw new Error(
							'dropdown_select requires string "value" (option value attribute)',
						);
					}
					console.log(
						`    -> dropdown_select(ref=${action.ref}, value=${JSON.stringify(action.value)})`,
					);
					await dropdownSelect(params.b, action.ref, action.value);
					break;
				case "navigate":
					if (!isSupportedInBrowserNavigateUrl(action.url)) {
						throw new Error(
							`navigate only supports in-browser document URLs (http/https/file/data/about); received "${action.url}"`,
						);
					}
					console.log(`    -> navigate("${action.url}")`);
					await navigate(params.b, action.url);
					break;
				case "switch_tab":
					const rawIndex = (action as { index?: unknown }).index;
					const tabIndex =
						typeof rawIndex === "number"
							? rawIndex
							: typeof rawIndex === "string" && rawIndex.trim() !== ""
								? Number(rawIndex)
								: Number.NaN;
					if (!Number.isInteger(tabIndex)) {
						throw new Error('switch_tab tool call requires an integer "index"');
					}
					if (tabIndex < 0 || tabIndex >= params.openTabs.length) {
						throw new Error(
							`switch_tab index ${tabIndex} is out of range for ${params.openTabs.length} open tab(s)`,
						);
					}
					const targetTab = params.openTabs[tabIndex];
					console.log(
						`    -> switch_tab(index=${tabIndex}, title="${formatTabTitle(targetTab)}")`,
					);
					await switchTab(params.b, targetTab.targetId);
					break;
				case "wait":
					console.log(`    -> wait(${action.ms}ms)`);
					await new Promise((r) => setTimeout(r, action.ms));
					break;
				case "download_current_file":
					console.log("    -> download_current_file()");
					const downloadedFilePath = await downloadCurrentFile(params.b);
					console.log(
						`       [download_current_file] saved to "${downloadedFilePath}"`,
					);
					break;
				case "upload_files":
					if (!params.fileWorkspaceRoot?.trim()) {
						throw new Error(
							"upload_files is unavailable because this browser session has no file workspace root",
						);
					}
					if (action.paths.length === 0) {
						throw new Error(
							'upload_files requires at least one path in "paths"',
						);
					}
					console.log(
						`    -> upload_files(ref=${action.ref}, paths=[${action.paths.map((entry) => JSON.stringify(entry)).join(", ")}])`,
					);
					const uploadResult = await uploadFiles({
						browser: params.b,
						ref: action.ref,
						paths: action.paths,
						fileWorkspaceRoot: params.fileWorkspaceRoot,
					});
					toolObservations.push(
						`[upload_files] ${JSON.stringify(uploadResult)}`,
					);
					break;
				case "paste_file":
					if (!params.fileWorkspaceRoot?.trim()) {
						throw new Error(
							"paste_file is unavailable because this browser session has no file workspace root",
						);
					}
					console.log(
						`    -> paste_file(ref=${action.ref}, path=${JSON.stringify(action.path)})`,
					);
					await pasteFile({
						browser: params.b,
						ref: action.ref,
						path: action.path,
						fileWorkspaceRoot: params.fileWorkspaceRoot,
					});
					break;
				case "user_takeover":
					const normalizedReason = validateUserTakeoverReason(action.reason);
					const normalizedCategory = normalizeUserTakeoverCategory({
						category: action.category,
						reason: normalizedReason,
					});
					const canAttemptAutomatedAuth =
						configFeatureFlags.authTakeover &&
						normalizedCategory === "authentication";

					if (
						!configFeatureFlags.userTakeoverTool &&
						!canAttemptAutomatedAuth
					) {
						console.log(
							`    -> user_takeover tool call ignored (manual takeover disabled)`,
						);
						interactionErrors.push(
							`user_takeover(reason="${normalizedReason}"): manual takeover disabled`,
						);
						break;
					}

					console.log(`    -> user_takeover(reason="${action.reason}")`);

					console.log(`    -> normalizedCategory: ${normalizedCategory}`);
					if (canAttemptAutomatedAuth) {
						const automatedResult = await params.attemptAutomatedAuthTakeover?.(
							{
								stepBaseIndex: params.stepBaseIndex,
							},
						);
						const normalizedAuthAttempts = normalizeAuthTakeoverAttempts(
							automatedResult,
							params.stepBaseIndex,
						);
						if (normalizedAuthAttempts.length > 0) {
							authTakeoverAttempts.push(...normalizedAuthAttempts);
							for (const attempt of normalizedAuthAttempts) {
								logAuthTakeoverAttemptEvent(attempt);
							}
						}

						if (automatedResult?.handled) {
							console.log(
								`    -> automated auth takeover handled request; suppressing user_takeover`,
							);
							break;
						}
						if (!configFeatureFlags.userTakeoverTool) {
							console.log(
								`    -> automated auth takeover did not handle request; manual takeover disabled`,
							);
							interactionErrors.push(
								`user_takeover(reason="${normalizedReason}"): automated auth not handled and manual takeover disabled`,
							);
							break;
						}
						console.log(
							`    -> automated auth takeover did not handle request; surfacing user_takeover`,
						);
					} else if (!configFeatureFlags.userTakeoverTool) {
						console.log(
							`    -> user_takeover tool call ignored (automatic auth unavailable)`,
						);
						interactionErrors.push(
							`user_takeover(reason="${normalizedReason}"): automatic auth unavailable and manual takeover disabled`,
						);
						break;
					}
					if (params.userActionBehavior === "return") {
						userTakeoverReason = normalizedReason;
						userTakeoverCategory = normalizedCategory;
					} else if (params.userActionBehavior === "callback") {
						await params.onUserActionRequired?.({
							kind: "browser_user_takeover",
							reason: normalizedReason,
							category: normalizedCategory,
						});
					} else {
						await params.onUserActionRequired?.({
							kind: "browser_user_takeover",
							reason: normalizedReason,
							category: normalizedCategory,
						});
						await waitForUserTakeoverSignal({
							browser: params.b,
							reason: normalizedReason,
						});
					}
					pendingUserTakeover = true;
					break;
				case "memory_write":
					console.log(
						`    -> memory_write(${action.content.slice(0, 150)}...)`,
					);
					appendMemoryFile({
						filePath: params.memoryFile,
						content: action.content,
					});
					break;
				case "memory_read":
					console.log(`    -> memory_read`);
					const memoryReadBarrier =
						await dataExtractionCoordinator.waitForAllAndFlush({
							filePath: extractDataMemoryFile,
						});
					toolObservations.push(...memoryReadBarrier.observations);
					if (memoryReadBarrier.errors.length > 0) {
						interactionErrors.push(...memoryReadBarrier.errors);
						dataExtractionBarrierFailed = true;
						break;
					}
					pendingMemoryRead = true;
					break;
				case "read_file": {
					console.log(`    -> read_file(path=${JSON.stringify(action.path)})`);
					const readFileBarrier =
						await dataExtractionCoordinator.waitForAllAndFlush({
							filePath: extractDataMemoryFile,
						});
					toolObservations.push(...readFileBarrier.observations);
					if (readFileBarrier.errors.length > 0) {
						interactionErrors.push(...readFileBarrier.errors);
						dataExtractionBarrierFailed = true;
						break;
					}
					const fileResult = await readLocalFile({
						requestedPath: action.path,
						downloadedFiles: params.downloadedFiles ?? [],
						fileWorkspaceRoot: params.fileWorkspaceRoot,
						downloadDir: params.b.downloadDir,
						downloadRootDir: params.b.downloadRootDir,
					});
					appendMemoryResultItems({
						filePath: extractDataMemoryFile,
						items: [
							{
								link: `file:${fileResult.path}`,
								summary: fileResult.content,
							},
						],
					});
					pendingMemoryRead = true;
					toolObservations.push(
						`read_file stored ${fileResult.path} in memory_result using ${fileResult.method}${fileResult.truncated ? " (truncated)" : ""}`,
					);
					break;
				}
				case "memory_clear":
					console.log(`    -> memory_clear(${action.target})`);
					if (action.target === "memory") {
						clearMemoryFile({
							filePath: params.memoryFile,
							target: "all",
						});
					} else if (action.target === "memory_result") {
						const prepareReplacement =
							hasResultExtractionBeforeNextBarrier(actionIndex);
						dataExtractionCoordinator.cancelAndDiscard({
							prepareReplacement,
						});
						if (!prepareReplacement) {
							clearMemoryFile({
								filePath: extractDataMemoryFile,
								target: "all",
							});
						}
					} else {
						clearMemoryFile({
							filePath: params.memoryFile,
							target: "all",
						});
						const prepareReplacement =
							hasResultExtractionBeforeNextBarrier(actionIndex);
						dataExtractionCoordinator.cancelAndDiscard({
							prepareReplacement,
						});
						if (!prepareReplacement) {
							clearMemoryFile({
								filePath: extractDataMemoryFile,
								target: "all",
							});
						}
					}
					break;
				case "return_results":
					console.log(`    -> return_results`);
					if (action.results) {
						if (!params.memoryContentAvailable) {
							throw new Error(
								"return_results with an explicit result list requires current memoryContent",
							);
						}
						returnedResult = formatExplicitResults(
							action.results,
							params.downloadedFiles,
						);
						break;
					}
					const returnResultsBarrier =
						await dataExtractionCoordinator.waitForAllAndFlush({
							filePath: extractDataMemoryFile,
						});
					toolObservations.push(...returnResultsBarrier.observations);
					if (returnResultsBarrier.errors.length > 0) {
						interactionErrors.push(...returnResultsBarrier.errors);
						dataExtractionBarrierFailed = true;
						break;
					}
					const extractedResult = fs.readFileSync(
						extractDataMemoryFile,
						"utf-8",
					);
					if (!extractedResult.trim() && !params.memoryContentAvailable) {
						throw new Error(
							"return_results requires completed extract_data or current memoryContent",
						);
					}
					returnedResult = extractMemoryResults(extractedResult);
					break;
				case "extract_data": {
					const wholeDocument = configFeatureFlags.extractDataWholeContext;
					const extractionRoot = wholeDocument ? "whole_document" : action.root;
					if (!extractionRoot) {
						throw new Error(
							"extract_data requires a root unless whole-context extraction is enabled",
						);
					}
					const regionDescription = wholeDocument
						? "scope=whole_document"
						: `root=${extractionRoot}`;
					console.log(`    -> extract_data(${regionDescription})`);
					const extractor =
						params.extractDataResultsFromSnapshot ??
						extractDataResultsFromSnapshot;
					if (!params.pageProjection?.trim()) {
						throw new Error(
							"extract_data requires semantic projection context",
						);
					}
					if (!params.dataExtractionLLMOptions) {
						throw new Error("extract_data requires dataExtraction LLM options");
					}
					const selectedProjection = wholeDocument
						? params.pageProjection
						: extractSemanticProjectionRegion({
								projection: params.pageProjection,
								root: extractionRoot,
							});
					dataExtractionCoordinator.launch({
						root: extractionRoot,
						run: async (abortSignal) =>
							await extractor({
								task: params.userTask ?? "",
								currentUrl: params.currentUrl ?? "",
								pageProjection: selectedProjection,
								llmOptions: params.dataExtractionLLMOptions!,
								openAIPromptCache: params.dataExtractionPromptCache,
								estimateTokenCount: params.estimateTokenCount,
								abortSignal,
								traceOptions: {
									onTrace: params.recordModelInvocation,
									meta: {
										step:
											typeof params.stepNumber === "number"
												? params.stepNumber
												: undefined,
										currentUrl: params.currentUrl,
										scope: wholeDocument ? "whole_document" : "rooted_subtree",
										...(!wholeDocument ? { root: extractionRoot } : {}),
									},
								},
							}),
					});
					toolObservations.push(
						`extract_data was launched asynchronously (${regionDescription}). The runtime will persist it before memory_read or return_results executes. Do not repeat this extraction unless that memory is intentionally cleared or replaced after this call.`,
					);
					console.log(`    -> extract_data launched asynchronously`);
					break;
				}
				case "agent_takeover": {
					const request = action.request.trim();
					if (!params.requestAgentTakeover) {
						interactionErrors.push("agent_takeover: OS assistance unavailable");
						break;
					}
					if (!request) {
						interactionErrors.push("agent_takeover: request must be non-empty");
						break;
					}
					console.log(`    -> agent_takeover("${request}")`);
					const result = await params.requestAgentTakeover({
						stepNumber: params.stepNumber,
						request,
						currentUrl: params.currentUrl,
						openTabs: params.openTabs.map((tab) => formatTabTitle(tab)),
						workspaceFiles: normalizeAgentTakeoverFileEntries(
							params.workspaceFiles,
						),
						downloadedFiles: normalizeAgentTakeoverFileEntries(
							params.downloadedFiles,
						),
					});
					if (result.status === "completed") {
						if (result.memoryContent?.trim()) {
							appendAgentTakeoverMemory({
								memoryFile: params.memoryFile,
								content: result.memoryContent,
							});
							pendingMemoryRead = true;
						}
						break;
					}
					interactionErrors.push(
						`agent_takeover: ${result.error || result.summary || result.status}`,
					);
					break;
				}
			}
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			console.log(`    -> ERROR: ${message}`);
			if (action.type === "custom_tool") {
				interactionErrors.push(`${action.name}(): ${message}`);
			} else if (action.type === "click") {
				interactionErrors.push(`click(ref=${action.ref}): ${message}`);
			} else if (action.type === "long_press") {
				interactionErrors.push(
					`long_press(ref=${action.ref}, durationMs=${action.durationMs ?? 3000}): ${message}`,
				);
			} else if (action.type === "type") {
				interactionErrors.push(`type(ref=${action.ref}): ${message}`);
			} else if (action.type === "scroll") {
				const deltaX =
					typeof action.deltaX === "number" && Number.isFinite(action.deltaX)
						? action.deltaX
						: 0;
				const deltaY =
					typeof action.deltaY === "number" && Number.isFinite(action.deltaY)
						? action.deltaY
						: 0;
				interactionErrors.push(
					`scroll(ref=${action.ref}, deltaX=${deltaX}, deltaY=${deltaY}): ${message}`,
				);
			} else if (action.type === "evaluate") {
				interactionErrors.push(`evaluate(script=...): ${message}`);
			} else if (action.type === "dropdown_select") {
				interactionErrors.push(
					`dropdown_select(ref=${action.ref}, value=${JSON.stringify(action.value)}): ${message}`,
				);
			} else if (action.type === "navigate") {
				interactionErrors.push(
					`navigate(url=${JSON.stringify(action.url)}): ${message}`,
				);
			} else if (action.type === "switch_tab") {
				interactionErrors.push(`switch_tab(index=${action.index}): ${message}`);
			} else if (action.type === "download_current_file") {
				interactionErrors.push(`download_current_file(): ${message}`);
			} else if (action.type === "upload_files") {
				interactionErrors.push(
					`upload_files(ref=${action.ref}, paths=[${action.paths.map((entry) => JSON.stringify(entry)).join(", ")}]): ${message}`,
				);
			} else if (action.type === "paste_file") {
				interactionErrors.push(
					`paste_file(ref=${action.ref}, path=${JSON.stringify(action.path)}): ${message}`,
				);
			} else if (action.type === "user_takeover") {
				interactionErrors.push(
					`user_takeover(reason="${action.reason}"): ${message}`,
				);
			} else if (action.type === "memory_read") {
				interactionErrors.push(`memory_read(): ${message}`);
			} else if (action.type === "read_file") {
				interactionErrors.push(
					`read_file(path=${JSON.stringify(action.path)}): ${message}`,
				);
			} else if (action.type === "return_results") {
				interactionErrors.push(`return_results(): ${message}`);
			} else if (action.type === "memory_clear") {
				interactionErrors.push(
					`memory_clear(target=${action.target}): ${message}`,
				);
			} else if (action.type === "extract_data") {
				interactionErrors.push(
					`extract_data(${configFeatureFlags.extractDataWholeContext ? "scope=whole_document" : `root=${action.root}`}): ${message}`,
				);
			}
		} finally {
			if (params.timingEnabled && params.stepTimings) {
				params.stepTimings.push({
					part: actionTimingPart,
					durationMs: Date.now() - actionStartedAt,
				});
			}
		}
		if (pendingUserTakeover || dataExtractionBarrierFailed) {
			break;
		}
		if (returnedResult !== undefined) break;
	}
	if (canConsumePrintRequests(params.b)) {
		try {
			const printPdfPaths = await consumePrintRequestsAndSavePdfs(params.b);
			for (const printPdfPath of printPdfPaths) {
				console.log(`    -> print_to_pdf saved "${printPdfPath}"`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			interactionErrors.push(`print_to_pdf(): ${message}`);
		}
	}

	return {
		pendingMemoryRead,
		interactionErrors,
		toolObservations,
		returnedResult,
		authTakeoverAttempts,
		userTakeover: userTakeoverReason
			? {
					reason: userTakeoverReason,
					...(userTakeoverCategory ? { category: userTakeoverCategory } : {}),
				}
			: undefined,
	};
}
