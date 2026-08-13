import path from "node:path";
import { BrowserAgentError } from "./errors.js";
import type {
	BrowserAgentCredential,
	BrowserAgentCustomTool,
	BrowserAgentOptions,
	BrowserAgentTask,
	Provider,
	ReasoningEffort,
} from "./types.js";

const CUSTOM_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const BUILT_IN_TOOL_NAMES = new Set([
	"agent_takeover",
	"click",
	"download_current_file",
	"dropdown_select",
	"evaluate",
	"extract_data",
	"long_press",
	"memory_clear",
	"memory_read",
	"memory_write",
	"navigate",
	"paste_file",
	"read_file",
	"return_results",
	"scroll",
	"switch_tab",
	"type",
	"upload_files",
	"user_takeover",
	"wait",
]);

const PROVIDER_ENV: Record<Provider, string | undefined> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GOOGLE_API_KEY",
	together: "TOGETHER_API_KEY",
	vllm: "VLLM_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	codex: undefined,
};
const OPENROUTER_REASONING_EFFORTS: readonly ReasoningEffort[] = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];
type Capability = [
	Provider,
	string,
	boolean,
	readonly ReasoningEffort[],
	ReasoningEffort,
];
const OPENAI = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"];
const GPT_5_6 = [
	"gpt-5.6-luna",
	"gpt-5.6-terra",
	"gpt-5.6-sol",
];
const CAPABILITIES: Capability[] = [
	...OPENAI.map((model): Capability => [
		"openai",
		model,
		false,
		["none", "minimal", "low", "medium", "high"],
		"low",
	]),
	...GPT_5_6.map((model): Capability => [
		"openai",
		model,
		false,
		["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		"low",
	]),
	...OPENAI.map((model): Capability => [
		"codex",
		model,
		false,
		["none", "minimal", "low", "medium", "high"],
		"low",
	]),
	...GPT_5_6.map((model): Capability => [
		"codex",
		model,
		false,
		["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		"low",
	]),
	["together", "zai-org/GLM-5.2", false, ["none", "high", "max"], "high"],
	[
		"together",
		"deepseek-ai/DeepSeek-V4-Flash-0731",
		false,
		["none", "low", "high", "max"],
		"high",
	],
	["vllm", "qwen", true, ["none", "enabled"], "enabled"],
	["vllm", "glm", true, ["none", "high", "max"], "high"],
	[
		"vllm",
		"deepseek-ai/DeepSeek-V4-Flash-0731",
		false,
		["none", "low", "high", "max"],
		"high",
	],
];

export interface ResolvedOptions extends Omit<
	BrowserAgentOptions,
	| "reasoningEffort"
	| "apiKey"
	| "maxModelLen"
	| "reserveOutputTokens"
	| "validatorLifecycle"
	| "customTools"
> {
	reasoningEffort: ReasoningEffort;
	apiKey?: string;
	maxModelLen: number;
	reserveOutputTokens: number;
	validatorLifecycle: "retry" | "disabled";
	customTools: readonly BrowserAgentCustomTool[];
	apiKeyEnvironment?: string;
}
const invalid = (message: string): never => {
	throw new BrowserAgentError("CONFIG_INVALID", message);
};
const positive = (value: number | undefined, fallback: number) => {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || result < 1)
		invalid("Execution limits must be positive integers.");
	return result;
};

function cloneJsonValue(value: unknown, ancestors = new Set<object>()): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	)
		return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			invalid("Custom tool schemas must contain valid JSON values.");
		return value;
	}
	if (!value || typeof value !== "object")
		invalid("Custom tool schemas must contain valid JSON values.");
	const objectValue = value as object;
	if (ancestors.has(objectValue))
		invalid("Custom tool schemas must not contain circular references.");
	ancestors.add(objectValue);
	try {
		if (Array.isArray(objectValue))
			return objectValue.map((item) => cloneJsonValue(item, ancestors));
		if (
			Object.getPrototypeOf(objectValue) !== Object.prototype &&
			Object.getPrototypeOf(objectValue) !== null
		)
			invalid("Custom tool schemas must be plain JSON objects.");
		return Object.fromEntries(
			Object.entries(objectValue).map(([key, item]) => [
				key,
				cloneJsonValue(item, ancestors),
			]),
		);
	} finally {
		ancestors.delete(objectValue);
	}
}

function normalizeCustomTools(
	tools: readonly BrowserAgentCustomTool[] | undefined,
): readonly BrowserAgentCustomTool[] {
	if (tools === undefined) return [];
	if (!Array.isArray(tools)) invalid("customTools must be an array.");
	const names = new Set<string>();
	return tools.map((tool) => {
		if (!tool || typeof tool !== "object" || Array.isArray(tool))
			invalid("Each custom tool must be an object.");
		if (typeof tool.name !== "string" || !CUSTOM_TOOL_NAME.test(tool.name))
			invalid(
				"Custom tool names must match ^[a-z][a-z0-9_]{0,63}$.",
			);
		if (BUILT_IN_TOOL_NAMES.has(tool.name))
			invalid(
				`Custom tool name '${tool.name}' conflicts with a built-in tool.`,
			);
		if (names.has(tool.name))
			invalid(`Duplicate custom tool name '${tool.name}'.`);
		names.add(tool.name);
		if (typeof tool.description !== "string" || !tool.description.trim())
			invalid("Custom tool descriptions must be non-empty strings.");
		if (
			!tool.arguments ||
			typeof tool.arguments !== "object" ||
			Array.isArray(tool.arguments) ||
			tool.arguments.type !== "object"
		)
			invalid(
				'Custom tool arguments must be a JSON Schema with type "object".',
			);
		const schema = cloneJsonValue(tool.arguments) as Record<string, unknown>;
		if (typeof tool.javascript !== "string" || !tool.javascript.trim())
			invalid("Custom tool javascript must be a non-empty string.");
		return {
			name: tool.name,
			description: tool.description.trim(),
			arguments: schema,
			javascript: tool.javascript.trim(),
		};
	});
}

export function resolveOptions(options: BrowserAgentOptions): ResolvedOptions {
	if (!options || typeof options !== "object")
		invalid("Options are required.");
	if (!Object.hasOwn(PROVIDER_ENV, options.provider))
		invalid(`Unsupported provider '${String(options.provider)}'.`);
	if (typeof options.model !== "string" || !options.model.trim())
		invalid("model must be a non-empty string.");
	if (
		typeof options.downloadDirectory !== "string" ||
		!options.downloadDirectory.trim()
	)
		invalid("downloadDirectory must be a non-empty string.");
	const model = options.model.trim();
	const capability = CAPABILITIES.find(
		([provider, name, contains]) =>
			provider === options.provider &&
			(contains ? model.toLowerCase().includes(name) : model === name),
	);
	if (
		!capability &&
		["openai", "codex", "together", "vllm"].includes(options.provider)
	)
		invalid(`Unknown model '${model}' for '${options.provider}'.`);
	const effort =
		options.reasoningEffort ??
		capability?.[4] ??
		invalid("reasoningEffort is required for this model.");
	if (
		options.provider === "openrouter" &&
		!OPENROUTER_REASONING_EFFORTS.includes(effort)
	)
		invalid(`Unsupported reasoningEffort '${effort}' for OpenRouter.`);
	if (capability && !capability[3].includes(effort))
		invalid(`Unsupported reasoningEffort '${effort}' for this model.`);
	if (options.provider === "codex" && options.apiKey !== undefined)
		invalid("apiKey cannot be used with Codex.");
	if (options.provider === "codex" && options.endpointUrl !== undefined)
		invalid("endpointUrl cannot be used with Codex.");
	if (options.endpointUrl) {
		try {
			if (
				!["http:", "https:"].includes(
					new URL(options.endpointUrl).protocol,
				)
			)
				throw new Error();
		} catch {
			invalid("endpointUrl must be an absolute HTTP(S) URL.");
		}
	}
	if (options.provider === "vllm" && !options.endpointUrl)
		invalid("endpointUrl is required for vllm.");
	if (
		options.openrouterProvider !== undefined &&
		(typeof options.openrouterProvider !== "string" ||
			!options.openrouterProvider.trim())
	)
		invalid("openrouterProvider must be a non-empty string.");
	if (
		options.openrouterProvider !== undefined &&
		options.provider !== "openrouter"
	)
		invalid("openrouterProvider can only be used with OpenRouter.");
	const apiKeyEnvironment = PROVIDER_ENV[options.provider];
	const apiKey =
		options.apiKey?.trim() ||
		(apiKeyEnvironment
			? process.env[apiKeyEnvironment]?.trim()
			: undefined);
	if (!["vllm", "codex"].includes(options.provider) && !apiKey)
		invalid(`Missing API key for provider '${options.provider}'.`);
	const retryCount = options.retryCount ?? 2;
	if (!Number.isInteger(retryCount) || retryCount < 0)
		invalid("retryCount must be an integer greater than or equal to zero.");
	const validatorLifecycle = options.validatorLifecycle ?? "retry";
	if (validatorLifecycle !== "retry" && validatorLifecycle !== "disabled")
		invalid("validatorLifecycle must be retry or disabled.");
	const maxModelLen = positive(options.maxModelLen, 48_000);
	const reserveOutputTokens = positive(options.reserveOutputTokens, 4_000);
	if (reserveOutputTokens >= maxModelLen) {
		invalid("reserveOutputTokens must be smaller than maxModelLen.");
	}
	const customTools = normalizeCustomTools(options.customTools);
	return {
		...options,
		model,
		reasoningEffort: effort,
		openrouterProvider: options.openrouterProvider?.trim(),
		apiKey,
		apiKeyEnvironment,
		downloadDirectory: path.resolve(options.downloadDirectory),
		workspaceDirectory: options.workspaceDirectory
			? path.resolve(options.workspaceDirectory)
			: undefined,
		browserProfileDirectory: options.browserProfileDirectory
			? path.resolve(options.browserProfileDirectory)
			: undefined,
		executablePath: options.executablePath
			? path.resolve(options.executablePath)
			: undefined,
		headless: options.headless ?? false,
		maxModelLen,
		reserveOutputTokens,
		userTakeoverTool: options.userTakeoverTool ?? false,
		customTools,
		maxSteps: positive(options.maxSteps, 50),
		concurrency: positive(options.concurrency, 8),
		runsPerTask: positive(options.runsPerTask, 1),
		retryCount,
		validatorLifecycle,
	};
}

export function normalizeTasks(
	input: BrowserAgentTask | readonly BrowserAgentTask[],
): BrowserAgentTask[] {
	const tasks = Array.isArray(input) ? [...input] : [input];
	if (!tasks.length) invalid("At least one task is required.");
	return tasks.map((item) => {
		if (!item || typeof item.task !== "string" || !item.task.trim())
			invalid("Each task must contain a non-empty task string.");
		if (item.url !== undefined && (!item.url || !item.url.trim()))
			invalid("Task URLs must be non-empty strings.");
		if (item.credentials !== undefined && !Array.isArray(item.credentials))
			invalid("Task credentials must be an array.");
		const credentials = item.credentials?.map(
			(credential: BrowserAgentCredential) => {
				if (!credential || typeof credential !== "object")
					invalid("Each credential must be an object.");
				if (
					typeof credential.username !== "string" ||
					!credential.username.trim()
				)
					invalid("Credential usernames must be non-empty strings.");
				if (
					typeof credential.password !== "string" ||
					!credential.password
				)
					invalid("Credential passwords must be non-empty strings.");
				if (
					typeof credential.domain !== "string" ||
					!credential.domain.trim()
				)
					invalid("Credential domains must be non-empty strings.");
				return {
					username: credential.username.trim(),
					password: credential.password,
					domain: credential.domain.trim(),
				};
			},
		);
		return {
			task: item.task.trim(),
			...(item.url ? { url: item.url.trim() } : {}),
			...(credentials?.length ? { credentials } : {}),
		};
	});
}

export function childEnvironment(options: ResolvedOptions): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const name of Object.values(PROVIDER_ENV))
		if (name) delete environment[name];
	if (options.apiKey && options.apiKeyEnvironment)
		environment[options.apiKeyEnvironment] = options.apiKey;
	return environment;
}
