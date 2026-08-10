import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as os from "node:os";
import yaml from "js-yaml";
import type { ConfigFeatureFlags } from "./config-feature-flags.js";
import type {
	ExtractionStepUsage,
	LLMOptions,
	Provider,
	RecapStageUsage,
	SuccessVerificationResult,
	StepTokenUsage,
} from "./agents/types.js";
import { SUPPORTED_PROVIDERS } from "./agents/types.js";
import {
	getReasoningModelCapability,
	validateReasoningConfiguration,
} from "./agents/reasoning-capabilities.js";
import {
	isProvider,
	isReasoningEffort,
	REASONING_EFFORTS,
} from "./llm-capabilities.js";
import type {
	AuthCredentialInput,
	AuthCredentialsInput,
	StoredEncryptedAuthCredentials,
} from "./auth/types.js";
import type { BrowserProfilesConfig } from "./browser/profile.js";
import type {
	StepRuntimeMetrics,
	ValidatorLifecycleOptions,
} from "./core/types.js";

type ReasoningEffort = NonNullable<LLMOptions["reasoningEffort"]>;

export interface CLIArgs {
	codexLogin?: boolean;
	codexLoginCheck?: boolean;
	config?: string;
	encryptValue?: string;
	generateKey?: boolean;
	help: boolean;
	rpc: boolean;
	version: boolean;
	versionJson: boolean;
}

export interface StageLLMOverride {
	provider?: Provider;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	maxModelLen?: number;
	reserveOutputTokens?: number;
	endpointUrl?: string;
	openrouterProvider?: string;
}

export interface StageLLMOverrides {
	findTargetURL?: StageLLMOverride;
	createChecklist?: StageLLMOverride;
	runAgent?: StageLLMOverride;
	dataExtraction?: StageLLMOverride;
	verifySuccess?: StageLLMOverride;
}

export interface StageLLMOptions {
	findTargetURL: LLMOptions;
	createChecklist: LLMOptions;
	runAgent: LLMOptions;
	dataExtraction: LLMOptions;
	verifySuccess: LLMOptions;
}

export interface Config {
	stageLLMs: StageLLMOptions;
	featureFlags: ConfigFeatureFlags;
	authCredentials?: AuthCredentialsInput;
	browserProfiles?: BrowserProfilesConfig;
	headless: boolean;
	maxSteps: number;
	validatorLifecycle: ValidatorLifecycleOptions;
	downloadDir?: string;
	fileWorkspaceRoot?: string;
	executablePath?: string;
	proxy?: {
		host: string;
		port: number;
	};
	waitBetweenTasksMs: number;
	taskRuns: number;
	taskRunRetryCount: number;
	taskUntilSuccessMaxAttempts?: number;
	tasks: ConfigTask[];
	concurrency: number;
	saveStepsContext: boolean;
	saveTaskLogs: boolean;
	stepMessagesJsonlPath: string;
	taskExecutionOverridesPath?: string;
}

export interface ConfigTask {
	task: string;
	url?: string;
	/** RPC-only, encrypted in memory after config parsing. */
	authCredentials?: StoredEncryptedAuthCredentials;
	/** RPC-only ephemeral key; never parsed from YAML. */
	authEncryptionKey?: string;
}

function configDir(): string {
	const override = process.env.BROWSER_AGENT_CONFIG_DIR?.trim();
	return override ? path.resolve(override) : process.cwd();
}

type StageLLMKey = keyof StageLLMOptions;

const STAGE_KEYS: Record<StageLLMKey, string[]> = {
	findTargetURL: ["findTargetURL", "find_target_url"],
	createChecklist: ["createChecklist", "create_checklist"],
	runAgent: ["runAgent", "run_agent"],
	dataExtraction: ["dataExtraction", "data_extraction"],
	verifySuccess: ["verifySuccess", "verify_success"],
};

const STAGE_OVERRIDE_ROOT_KEYS = [
	"stage_llms",
	"stageLLMs",
	"llms_by_stage",
	"llmsByStage",
	"models",
	"model_by_stage",
	"modelByStage",
];

const LEGACY_RUN_AGENT_STAGE_KEYS = ["executeLoop", "execute_loop"] as const;
const REMOVED_CREATE_PLAN_STAGE_KEYS = ["createPlan", "create_plan"] as const;
const REMOVED_DISMISS_COOKIE_STAGE_KEYS = [
	"dismissCookieBanner",
	"dismiss_cookie_banner",
] as const;
const REMOVED_CONFIG_FEATURE_FLAG_KEYS = [
	"dismiss_cookie_banner",
	"dismissCookieBanner",
	"website_apification_tools",
	"websiteAPIficationTools",
] as const;

const DEFAULT_DATA_EXTRACTION_LLM: LLMOptions = {
	provider: "openai",
	model: "gpt-5.4-mini",
	reasoningEffort: "low",
};

function failConfig(message: string): never {
	console.error(message);
	process.exit(1);
}

function pickFirstDefined(
	source: Record<string, unknown>,
	keys: string[],
): unknown {
	for (const key of keys) {
		const value = source[key];
		if (value !== undefined) return value;
	}
	return undefined;
}

function parseProviderValue(
	value: unknown,
	fullPath: string,
	context: string,
): Provider {
	if (typeof value !== "string") {
		failConfig(
			`Invalid ${context} in config: ${fullPath}. Use one of: ${SUPPORTED_PROVIDERS.join(", ")}.`,
		);
	}
	const normalized = value.trim();
	if (!isProvider(normalized)) {
		failConfig(
			`Invalid ${context} in config: ${fullPath}. Use one of: ${SUPPORTED_PROVIDERS.join(", ")}.`,
		);
	}
	return normalized;
}

function resolveConfigRelativePath(value: string, configPath: string): string {
	return path.isAbsolute(value)
		? value
		: path.resolve(path.dirname(configPath), value);
}

function parseOptionalProviderValue(
	value: unknown,
	fullPath: string,
	context: string,
): Provider | undefined {
	if (value === undefined) return undefined;
	return parseProviderValue(value, fullPath, context);
}

function parseOptionalNonEmptyString(
	value: unknown,
	fullPath: string,
	context: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		failConfig(
			`Invalid ${context} in config: ${fullPath}. Use a non-empty string.`,
		);
	}
	return value.trim();
}

function parseOptionalReasoningEffort(
	value: unknown,
	fullPath: string,
	context: string,
): ReasoningEffort | undefined {
	if (value === undefined) return undefined;
	if (!isReasoningEffort(value)) {
		failConfig(
			`Invalid ${context} in config: ${fullPath}. Use one of: ${REASONING_EFFORTS.map((effort) => `"${effort}"`).join(", ")}.`,
		);
	}
	return value;
}

function parseOptionalPositiveInteger(
	value: unknown,
	fullPath: string,
	context: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		failConfig(
			`Invalid ${context} in config: ${fullPath}. Use a positive integer.`,
		);
	}
	return value;
}

function parseOptionalEndpointSettings(
	source: Record<string, unknown>,
	fullPath: string,
	context: string,
): Pick<StageLLMOverride, "endpointUrl"> {
	const endpointUrlInput = pickFirstDefined(source, [
		"endpoint_url",
		"endpointUrl",
	]);
	if (endpointUrlInput !== undefined && typeof endpointUrlInput !== "string") {
		failConfig(
			`Invalid ${context} endpoint_url in config: ${fullPath}. Use a string URL.`,
		);
	}
	return {
		endpointUrl:
			typeof endpointUrlInput === "string" && endpointUrlInput.trim()
				? endpointUrlInput.trim()
				: undefined,
	};
}

function parseOptionalOpenRouterProvider(
	source: Record<string, unknown>,
	fullPath: string,
	context: string,
): string | undefined {
	return parseOptionalNonEmptyString(
		pickFirstDefined(source, ["openrouter_provider", "openrouterProvider"]),
		fullPath,
		`${context} openrouter_provider`,
	);
}

function asRecord(
	value: unknown,
	fullPath: string,
	context: string,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		failConfig(
			`Invalid ${context} value in config: ${fullPath}. Use an object/map.`,
		);
	}
	return value as Record<string, unknown>;
}

function parseBooleanConfigValue(
	value: unknown,
	fullPath: string,
	context: string,
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		failConfig(
			`Invalid ${context} value in config: ${fullPath}. Use true or false.`,
		);
	}
	return value;
}

function parseSemanticProjectionHistory(
	value: unknown,
	fullPath: string,
): "current" | "cumulative" {
	if (value === undefined) return "current";
	if (value === "current" || value === "cumulative") return value;
	failConfig(
		`Invalid feature_flags.semantic_projection_history value in config: ${fullPath}. Use "current" or "cumulative".`,
	);
}

const LEGACY_PROVIDER_KEYS = new Set([
	"openai_api_key",
	"openaiApiKey",
	"together_api_key",
	"togetherApiKey",
	"vllm_base_url",
	"vllmBaseURL",
	"vllm_api_key",
	"vllmApiKey",
	"vllm_lora_name",
	"vllmLoraName",
	"vllm_lora_path",
	"vllmLoraPath",
	"vllm_lora_int_id",
	"vllmLoraIntId",
]);

function assertNoLegacyProviderKeys(
	source: Record<string, unknown>,
	fullPath: string,
	context: string,
): void {
	for (const key of Object.keys(source)) {
		if (!LEGACY_PROVIDER_KEYS.has(key)) {
			continue;
		}
		failConfig(
			`Invalid ${context} in config: ${fullPath}. '${key}' is no longer supported. Use endpoint_url/endpointUrl only.`,
		);
	}
}

function parseEncryptedAuthCredentialsConfig(
	value: unknown,
	fullPath: string,
): AuthCredentialsInput | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) {
		if (value.length === 0) {
			failConfig(
				`Invalid auth_credentials in config: ${fullPath}. Use a non-empty array when providing multiple encrypted auth credentials.`,
			);
		}
		return value.map((entry, index) =>
			parseEncryptedAuthCredentialEntry(entry, `${fullPath}[${index}]`),
		);
	}
	return parseEncryptedAuthCredentialEntry(value, fullPath);
}

function parseEncryptedAuthCredentialEntry(
	value: unknown,
	fullPath: string,
): AuthCredentialInput {
	const authSource = asRecord(value, fullPath, "auth_credentials");
	const mode = pickFirstDefined(authSource, ["mode"]);
	if (mode !== undefined && mode !== "encrypted") {
		failConfig(
			`Invalid auth_credentials.mode in config: ${fullPath}. YAML config only supports mode: "encrypted".`,
		);
	}
	const plaintextKeys = ["domain_url", "domainUrl", "username", "password"];
	for (const key of plaintextKeys) {
		if (authSource[key] !== undefined) {
			failConfig(
				`Invalid auth_credentials.${key} in config: ${fullPath}. YAML config must store encrypted auth data only.`,
			);
		}
	}
	const encryptedDomainUrl = parseOptionalNonEmptyString(
		pickFirstDefined(authSource, [
			"encrypted_domain_url",
			"encryptedDomainUrl",
		]),
		fullPath,
		"auth_credentials.encrypted_domain_url",
	);
	const encryptedUsername = parseOptionalNonEmptyString(
		pickFirstDefined(authSource, ["encrypted_username", "encryptedUsername"]),
		fullPath,
		"auth_credentials.encrypted_username",
	);
	const encryptedPassword = parseOptionalNonEmptyString(
		pickFirstDefined(authSource, ["encrypted_password", "encryptedPassword"]),
		fullPath,
		"auth_credentials.encrypted_password",
	);
	const hasAny =
		encryptedDomainUrl !== undefined ||
		encryptedUsername !== undefined ||
		encryptedPassword !== undefined;
	if (!hasAny) {
		failConfig(
			`Invalid auth_credentials in config: ${fullPath}. Provide encrypted_domain_url, encrypted_username, and encrypted_password together.`,
		);
	}
	if (
		encryptedDomainUrl === undefined ||
		encryptedUsername === undefined ||
		encryptedPassword === undefined
	) {
		failConfig(
			`Invalid auth_credentials in config: ${fullPath}. Provide encrypted_domain_url, encrypted_username, and encrypted_password together.`,
		);
	}
	return {
		mode: "encrypted",
		encryptedDomainUrl,
		encryptedUsername,
		encryptedPassword,
	};
}

function parseBrowserProfilesConfig(
	value: unknown,
	fullPath: string,
): BrowserProfilesConfig | undefined {
	if (value === undefined) {
		return undefined;
	}
	const source = asRecord(value, fullPath, "browser_profiles");
	const mode = parseOptionalNonEmptyString(
		pickFirstDefined(source, ["mode"]),
		fullPath,
		"browser_profiles.mode",
	);
	if (!mode) {
		failConfig(
			`Invalid browser_profiles in config: ${fullPath}. Provide browser_profiles.mode.`,
		);
	}
	if (mode !== "seeded") {
		failConfig(
			`Invalid browser_profiles.mode in config: ${fullPath}. Supported mode is "seeded".`,
		);
	}

	const seedUserDataDir = parseOptionalNonEmptyString(
		pickFirstDefined(source, ["seed_user_data_dir", "seedUserDataDir"]),
		fullPath,
		"browser_profiles.seed_user_data_dir",
	);
	const perWorkerUserDataRoot = parseOptionalNonEmptyString(
		pickFirstDefined(source, [
			"per_worker_user_data_root",
			"perWorkerUserDataRoot",
		]),
		fullPath,
		"browser_profiles.per_worker_user_data_root",
	);
	if (!seedUserDataDir || !perWorkerUserDataRoot) {
		failConfig(
			`Invalid browser_profiles in config: ${fullPath}. Provide browser_profiles.seed_user_data_dir and browser_profiles.per_worker_user_data_root.`,
		);
	}

	return {
		mode: "seeded",
		seedUserDataDir: resolveConfigRelativePath(seedUserDataDir, fullPath),
		perWorkerUserDataRoot: resolveConfigRelativePath(
			perWorkerUserDataRoot,
			fullPath,
		),
		reuseExistingWorkerProfiles:
			parseBooleanConfigValue(
				pickFirstDefined(source, [
					"reuse_existing_worker_profiles",
					"reuseExistingWorkerProfiles",
				]),
				fullPath,
				"browser_profiles.reuse_existing_worker_profiles",
			) ?? false,
	};
}

function parseStageLLMOverride(
	stage: StageLLMKey,
	stageOverridesSource: Record<string, unknown>,
	topLevelSource: Record<string, unknown>,
	fullPath: string,
): StageLLMOverride | undefined {
	let stageValue = pickFirstDefined(stageOverridesSource, STAGE_KEYS[stage]);
	if (stageValue === undefined) {
		stageValue = pickFirstDefined(topLevelSource, STAGE_KEYS[stage]);
	}
	if (stageValue === undefined) return undefined;

	if (typeof stageValue === "string") {
		if (!stageValue.trim()) {
			failConfig(
				`Invalid model override for '${stage}' in config: ${fullPath}. Use a non-empty string.`,
			);
		}
		return { model: stageValue.trim() };
	}

	const stageRecord = asRecord(
		stageValue,
		fullPath,
		`stage override for '${stage}'`,
	);
	assertNoLegacyProviderKeys(
		stageRecord,
		fullPath,
		`stage override for '${stage}'`,
	);
	const provider = parseOptionalProviderValue(
		pickFirstDefined(stageRecord, ["provider"]),
		fullPath,
		`provider for stage '${stage}'`,
	);
	const model = parseOptionalNonEmptyString(
		pickFirstDefined(stageRecord, ["model"]),
		fullPath,
		`model for stage '${stage}'`,
	);
	const reasoningEffort = parseOptionalReasoningEffort(
		pickFirstDefined(stageRecord, ["reasoning_effort", "reasoningEffort"]),
		fullPath,
		`reasoning_effort for stage '${stage}'`,
	);
	const maxModelLen = parseOptionalPositiveInteger(
		pickFirstDefined(stageRecord, ["max_model_len", "maxModelLen"]),
		fullPath,
		`max_model_len for stage '${stage}'`,
	);
	const reserveOutputTokens = parseOptionalPositiveInteger(
		pickFirstDefined(stageRecord, [
			"reserve_output_tokens",
			"reserveOutputTokens",
		]),
		fullPath,
		`reserve_output_tokens for stage '${stage}'`,
	);
	const stageEndpointSettings = parseOptionalEndpointSettings(
		stageRecord,
		fullPath,
		`stage '${stage}'`,
	);
	const openrouterProvider = parseOptionalOpenRouterProvider(
		stageRecord,
		fullPath,
		`stage '${stage}'`,
	);

	if (
		provider === undefined &&
		model === undefined &&
		reasoningEffort === undefined &&
		maxModelLen === undefined &&
		reserveOutputTokens === undefined &&
		stageEndpointSettings.endpointUrl === undefined &&
		openrouterProvider === undefined
	) {
		failConfig(
			`Invalid stage override for '${stage}' in config: ${fullPath}. Provide at least one of provider/model/reasoning_effort/max_model_len/reserve_output_tokens/endpoint_url/openrouter_provider fields.`,
		);
	}

	return {
		...(provider !== undefined ? { provider } : {}),
		...(model !== undefined ? { model } : {}),
		reasoningEffort,
		...(maxModelLen !== undefined ? { maxModelLen } : {}),
		...(reserveOutputTokens !== undefined ? { reserveOutputTokens } : {}),
		...stageEndpointSettings,
		...(openrouterProvider !== undefined ? { openrouterProvider } : {}),
	};
}

function assertNoLegacyRunAgentStageKeys(
	source: Record<string, unknown>,
	fullPath: string,
	context: string,
): void {
	for (const key of LEGACY_RUN_AGENT_STAGE_KEYS) {
		if (source[key] === undefined) continue;
		failConfig(
			`Invalid ${context} in config: ${fullPath}. '${key}' has been renamed to 'runAgent'. Update your YAML to use runAgent/run_agent.`,
		);
	}
}

function assertNoRemovedCreatePlanStageKeys(
	source: Record<string, unknown>,
	fullPath: string,
	context: string,
): void {
	for (const key of REMOVED_CREATE_PLAN_STAGE_KEYS) {
		if (source[key] === undefined) continue;
		failConfig(
			`Invalid ${context}.${key} in config: ${fullPath}. The createPlan stage has been removed; configure createChecklist and verifySuccess directly instead.`,
		);
	}
}

function assertNoRemovedDismissCookieStageKeys(
	source: Record<string, unknown>,
	fullPath: string,
	context: string,
): void {
	for (const key of REMOVED_DISMISS_COOKIE_STAGE_KEYS) {
		if (source[key] === undefined) continue;
		failConfig(
			`Invalid ${context}.${key} in config: ${fullPath}. The dismissCookieBanner stage has been removed.`,
		);
	}
}

function validateResolvedPromptBudget(
	options: Pick<LLMOptions, "maxModelLen" | "reserveOutputTokens">,
	fullPath: string,
	context: string,
): void {
	const hasMaxModelLen = options.maxModelLen !== undefined;
	const hasReserveOutputTokens = options.reserveOutputTokens !== undefined;
	if (hasMaxModelLen !== hasReserveOutputTokens) {
		failConfig(
			`Invalid ${context} prompt budget in config: ${fullPath}. Provide max_model_len and reserve_output_tokens together.`,
		);
	}
	if (!hasMaxModelLen || !hasReserveOutputTokens) return;
	const maxModelLen = options.maxModelLen as number;
	const reserveOutputTokens = options.reserveOutputTokens as number;
	if (maxModelLen <= reserveOutputTokens) {
		failConfig(
			`Invalid ${context} prompt budget in config: ${fullPath}. max_model_len must be greater than reserve_output_tokens.`,
		);
	}
}

function resolveStageLLMOptions(
	stage: StageLLMKey,
	stageOverridesSource: Record<string, unknown>,
	topLevelSource: Record<string, unknown>,
	fullPath: string,
	defaultLLM?: StageLLMOverride,
): LLMOptions {
	const override = parseStageLLMOverride(
		stage,
		stageOverridesSource,
		topLevelSource,
		fullPath,
	);
	const provider = override?.provider ?? defaultLLM?.provider;
	if (!provider) {
		failConfig(
			`Invalid config file: ${fullPath}. Missing provider for stage '${stage}'. Define stage_llms.${stage}.provider (or set a default provider/model).`,
		);
	}
	const model = override?.model ?? defaultLLM?.model;
	if (!model) {
		failConfig(
			`Invalid config file: ${fullPath}. Missing model for stage '${stage}'. Define stage_llms.${stage}.model (or set a default provider/model).`,
		);
	}
	const canInheritDefaultReasoning =
		provider !== "openrouter" ||
		(override?.provider === undefined && override?.model === undefined);
	const reasoningEffort =
		override?.reasoningEffort ??
		(canInheritDefaultReasoning ? defaultLLM?.reasoningEffort : undefined) ??
		getReasoningModelCapability(provider, model)?.defaultReasoningEffort;
	if (!reasoningEffort) {
		failConfig(
			`Invalid config file: ${fullPath}. Missing reasoning_effort for stage '${stage}'. Define stage_llms.${stage}.reasoning_effort (or set a default reasoning_effort).`,
		);
	}
	const openrouterProvider =
		override?.openrouterProvider ??
		(provider === "openrouter" ? defaultLLM?.openrouterProvider : undefined);
	if (openrouterProvider !== undefined && provider !== "openrouter") {
		failConfig(
			`Invalid openrouter_provider for stage '${stage}' in config: ${fullPath}. openrouter_provider can only be used with provider 'openrouter'.`,
		);
	}

	const resolved: LLMOptions = {
		provider,
		model,
		reasoningEffort,
		...((override?.maxModelLen ?? defaultLLM?.maxModelLen) !== undefined
			? {
					maxModelLen: override?.maxModelLen ?? defaultLLM?.maxModelLen,
				}
			: {}),
		...((override?.reserveOutputTokens ?? defaultLLM?.reserveOutputTokens) !==
		undefined
			? {
					reserveOutputTokens:
						override?.reserveOutputTokens ?? defaultLLM?.reserveOutputTokens,
				}
			: {}),
		endpointUrl:
			override?.endpointUrl ??
			(provider === "codex" ? undefined : defaultLLM?.endpointUrl),
		...(openrouterProvider !== undefined ? { openrouterProvider } : {}),
	};
	if (provider === "codex" && resolved.endpointUrl !== undefined) {
		failConfig(
			`Invalid endpoint_url for stage '${stage}' in config: ${fullPath}. Provider 'codex' uses a fixed endpoint and does not allow endpoint_url.`,
		);
	}
	try {
		validateReasoningConfiguration(resolved);
	} catch (error) {
		failConfig(
			`Invalid reasoning configuration for stage '${stage}' in config: ${fullPath}. ${(error as Error).message}`,
		);
	}
	validateResolvedPromptBudget(resolved, fullPath, `stage '${stage}'`);
	return resolved;
}

function parseConfigTaskEntry(
	value: unknown,
	fullPath: string,
	context: string,
): ConfigTask | null {
	if (typeof value === "string") {
		const task = value.trim();
		return task ? { task } : null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		failConfig(
			`Invalid ${context} in config: ${fullPath}. Use a task string or an object with 'task' and optional 'url'.`,
		);
	}
	const source = value as Record<string, unknown>;
	const allowedKeys = new Set(["task", "url"]);
	for (const key of Object.keys(source)) {
		if (!allowedKeys.has(key)) {
			failConfig(
				`Invalid ${context}.${key} in config: ${fullPath}. Supported fields are 'task' and 'url'.`,
			);
		}
	}
	const task = source.task;
	if (typeof task !== "string" || !task.trim()) {
		failConfig(
			`Invalid ${context}.task in config: ${fullPath}. Use a non-empty task string.`,
		);
	}
	const url = source.url;
	if (url !== undefined && (typeof url !== "string" || !url.trim())) {
		failConfig(
			`Invalid ${context}.url in config: ${fullPath}. Use a non-empty URL string.`,
		);
	}
	return {
		task: task.trim(),
		...(typeof url === "string" && url.trim() ? { url: url.trim() } : {}),
	};
}

function parseConfigTasks(value: unknown, fullPath: string): ConfigTask[] {
	if (Array.isArray(value)) {
		return value
			.map((entry, index) =>
				parseConfigTaskEntry(entry, fullPath, `tasks[${index}]`),
			)
			.filter((entry): entry is ConfigTask => entry !== null);
	}
	if (typeof value === "string" && value.trim()) {
		return [{ task: value.trim() }];
	}
	if (value !== undefined) {
		failConfig(
			`Invalid tasks in config: ${fullPath}. Use 'tasks: ["..."]', 'tasks: [{ task: "...", url: "..." }]', or 'task: "...".`,
		);
	}
	return [];
}

export function loadConfig(configPath: string): Config {
	let fullPath = configPath;

	// Bare names resolve from the caller's config directory or current working
	// directory. Published builds must not depend on a sibling repository config.
	if (!configPath.includes("/") && !configPath.includes("\\")) {
		const withExt = configPath.endsWith(".yaml")
			? configPath
			: `${configPath}.yaml`;
		fullPath = path.join(configDir(), withExt);
	} else {
		fullPath = path.resolve(configPath);
	}

	if (!fs.existsSync(fullPath)) {
		failConfig(`Config file not found: ${fullPath}`);
	}

	const content = fs.readFileSync(fullPath, "utf-8");
	const parsed = yaml.load(content);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		failConfig(`Invalid config file: ${fullPath}. Expected a YAML object.`);
	}
	const raw = parsed as Record<string, unknown>;

	const llmBlockInput = pickFirstDefined(raw, [
		"llm",
		"default_llm",
		"defaultLLM",
	]);
	const llmBlock =
		llmBlockInput === undefined ? {} : asRecord(llmBlockInput, fullPath, "llm");
	const llmSource: Record<string, unknown> = {
		...raw,
		...llmBlock,
	};
	assertNoLegacyProviderKeys(llmSource, fullPath, "default LLM settings");

	const providerInput = pickFirstDefined(llmSource, ["provider"]);
	const modelInput = pickFirstDefined(llmSource, ["model"]);
	const hasDefaultProvider = providerInput !== undefined;
	const hasDefaultModel = modelInput !== undefined;
	if (hasDefaultProvider !== hasDefaultModel) {
		failConfig(
			`Invalid config file: ${fullPath}. Default provider/model must be provided together (top-level or under 'llm').`,
		);
	}

	let defaultLLM: StageLLMOverride | undefined;
	const defaultReasoningEffort = parseOptionalReasoningEffort(
		pickFirstDefined(llmSource, ["reasoning_effort", "reasoningEffort"]),
		fullPath,
		"default reasoning_effort",
	);
	const defaultOpenRouterProvider = parseOptionalOpenRouterProvider(
		llmSource,
		fullPath,
		"default",
	);
	if (hasDefaultProvider && hasDefaultModel) {
		const provider = parseProviderValue(
			providerInput,
			fullPath,
			"default provider",
		);
		const model = parseOptionalNonEmptyString(
			modelInput,
			fullPath,
			"default model",
		);
		if (!model) {
			failConfig(
				`Invalid default model in config: ${fullPath}. Use a non-empty string.`,
			);
		}
		if (defaultOpenRouterProvider !== undefined && provider !== "openrouter") {
			failConfig(
				`Invalid default openrouter_provider in config: ${fullPath}. openrouter_provider can only be used with provider 'openrouter'.`,
			);
		}
		const defaultEndpointSettings = parseOptionalEndpointSettings(
			llmSource,
			fullPath,
			"default",
		);
		if (
			provider === "codex" &&
			defaultEndpointSettings.endpointUrl !== undefined
		) {
			failConfig(
				`Invalid default endpoint_url in config: ${fullPath}. Provider 'codex' uses a fixed endpoint and does not allow endpoint_url.`,
			);
		}
		const defaultMaxModelLen = parseOptionalPositiveInteger(
			pickFirstDefined(llmSource, ["max_model_len", "maxModelLen"]),
			fullPath,
			"default max_model_len",
		);
		const defaultReserveOutputTokens = parseOptionalPositiveInteger(
			pickFirstDefined(llmSource, [
				"reserve_output_tokens",
				"reserveOutputTokens",
			]),
			fullPath,
			"default reserve_output_tokens",
		);
		defaultLLM = {
			provider,
			model,
			...(defaultReasoningEffort !== undefined
				? { reasoningEffort: defaultReasoningEffort }
				: {}),
			...(defaultMaxModelLen !== undefined
				? { maxModelLen: defaultMaxModelLen }
				: {}),
			...(defaultReserveOutputTokens !== undefined
				? { reserveOutputTokens: defaultReserveOutputTokens }
				: {}),
			...(defaultOpenRouterProvider !== undefined
				? { openrouterProvider: defaultOpenRouterProvider }
				: {}),
			...defaultEndpointSettings,
		};
		validateResolvedPromptBudget(defaultLLM, fullPath, "default");
	} else if (
		defaultReasoningEffort !== undefined ||
		defaultOpenRouterProvider !== undefined
	) {
		defaultLLM = {
			...(defaultReasoningEffort !== undefined
				? { reasoningEffort: defaultReasoningEffort }
				: {}),
			...(defaultOpenRouterProvider !== undefined
				? { openrouterProvider: defaultOpenRouterProvider }
				: {}),
		};
	}

	const stageOverridesInput = pickFirstDefined(raw, STAGE_OVERRIDE_ROOT_KEYS);
	const stageOverridesSource =
		stageOverridesInput === undefined
			? {}
			: asRecord(stageOverridesInput, fullPath, "stage LLM overrides");
	assertNoLegacyRunAgentStageKeys(
		stageOverridesSource,
		fullPath,
		"stage LLM overrides",
	);
	assertNoLegacyRunAgentStageKeys(raw, fullPath, "config");
	assertNoRemovedCreatePlanStageKeys(
		stageOverridesSource,
		fullPath,
		"stage LLM overrides",
	);
	assertNoRemovedCreatePlanStageKeys(raw, fullPath, "config");
	assertNoRemovedDismissCookieStageKeys(
		stageOverridesSource,
		fullPath,
		"stage LLM overrides",
	);
	assertNoRemovedDismissCookieStageKeys(raw, fullPath, "config");
	const createChecklistStageLLM = resolveStageLLMOptions(
		"createChecklist",
		stageOverridesSource,
		raw,
		fullPath,
		defaultLLM,
	);
	const stageLLMs: StageLLMOptions = {
		findTargetURL: resolveStageLLMOptions(
			"findTargetURL",
			stageOverridesSource,
			raw,
			fullPath,
			defaultLLM,
		),
		createChecklist: createChecklistStageLLM,
		runAgent: resolveStageLLMOptions(
			"runAgent",
			stageOverridesSource,
			raw,
			fullPath,
			defaultLLM,
		),
		dataExtraction: resolveStageLLMOptions(
			"dataExtraction",
			stageOverridesSource,
			raw,
			fullPath,
			defaultLLM?.provider === "codex"
				? defaultLLM
				: {
						...DEFAULT_DATA_EXTRACTION_LLM,
						...((defaultLLM?.provider === undefined ||
							defaultLLM.provider ===
								DEFAULT_DATA_EXTRACTION_LLM.provider) &&
						defaultLLM?.reasoningEffort !== undefined
							? { reasoningEffort: defaultLLM.reasoningEffort }
							: {}),
					},
		),
		verifySuccess: resolveStageLLMOptions(
			"verifySuccess",
			stageOverridesSource,
			raw,
			fullPath,
			defaultLLM,
		),
	};
	const featureFlagsInput = pickFirstDefined(raw, [
		"feature_flags",
		"featureFlags",
	]);
	const featureFlagsSource =
		featureFlagsInput === undefined
			? {}
			: asRecord(featureFlagsInput, fullPath, "feature_flags");
	for (const removedKey of REMOVED_CONFIG_FEATURE_FLAG_KEYS) {
		if (featureFlagsSource[removedKey] === undefined) continue;
		failConfig(
			`feature_flags.${removedKey} has been removed; its behavior is permanently disabled.`,
		);
	}
	for (const removedKey of [
		"omit_executor_thinking_field",
		"omitExecutorThinkingField",
	]) {
		if (featureFlagsSource[removedKey] === undefined) continue;
		failConfig(
			`feature_flags.${removedKey} has been removed; the executor thinking field is always omitted.`,
		);
	}
	for (const legacyKey of [
		"disable_qwen_reasoning_for_run_agent",
		"disableQwenReasoningForRunAgent",
		"executor_reasoning",
		"executorReasoning",
		"adaptive_executor_reasoning",
		"adaptiveExecutorReasoning",
	]) {
		if (featureFlagsSource[legacyKey] === undefined) continue;
		failConfig(
			`feature_flags.${legacyKey} has been removed. Set reasoning_effort on the relevant stage_llms entry instead.`,
		);
	}
	for (const legacyKey of [
		"openai_stateful_responses",
		"openAIStatefulResponses",
	]) {
		if (featureFlagsSource[legacyKey] === undefined) continue;
		failConfig(
			`feature_flags.${legacyKey} has been removed. Use feature_flags.openai_encrypted_responses instead.`,
		);
	}
	for (const [legacyKey, configPathLabel] of [
		[
			"executor_action_context_fields",
			"feature_flags.executor_action_context_fields",
		],
		[
			"executorActionContextFields",
			"feature_flags.executorActionContextFields",
		],
	] as const) {
		if (featureFlagsSource[legacyKey] !== undefined) {
			failConfig(
				`${configPathLabel} has been removed; executor action-context fields are controlled by the internal featureFlags.executorActionContextFields flag.`,
			);
		}
	}
	const configuredFeatureFlags: ConfigFeatureFlags = {
		taskChecklist:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, [
					"task_checklist",
					"taskChecklist",
				]),
				fullPath,
				"feature_flags.task_checklist",
			) ?? true,
		preStepScreenshotInLatestUserPrompt:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, [
					"pre_step_screenshot_in_latest_user_prompt",
					"preStepScreenshotInLatestUserPrompt",
				]),
				fullPath,
				"feature_flags.pre_step_screenshot_in_latest_user_prompt",
			) ?? false,
		userTakeoverTool:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, [
					"user_takeover_tool",
					"userTakeoverTool",
				]),
				fullPath,
				"feature_flags.user_takeover_tool",
			) ?? true,
		authTakeover:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, ["auth_takeover", "authTakeover"]),
				fullPath,
				"feature_flags.auth_takeover",
			) ?? false,
		agentTakeoverTool:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, [
					"agent_takeover_tool",
					"agentTakeoverTool",
				]),
				fullPath,
				"feature_flags.agent_takeover_tool",
			) ?? false,
		extractDataWholeContext:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, [
					"extract_data_whole_context",
					"extractDataWholeContext",
				]),
				fullPath,
				"feature_flags.extract_data_whole_context",
			) ?? false,
		semanticProjectionHistory: parseSemanticProjectionHistory(
			pickFirstDefined(featureFlagsSource, [
				"semantic_projection_history",
				"semanticProjectionHistory",
			]),
			fullPath,
		),
		openAIEncryptedResponses:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, [
					"openai_encrypted_responses",
					"openAIEncryptedResponses",
				]),
				fullPath,
				"feature_flags.openai_encrypted_responses",
			) ?? true,
		openAIExplicitPromptCaching:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, [
					"openai_explicit_prompt_caching",
					"openAIExplicitPromptCaching",
				]),
				fullPath,
				"feature_flags.openai_explicit_prompt_caching",
			) ?? true,
		optimizeExecutorStepDelays:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, [
					"optimize_executor_step_delays",
					"optimizeExecutorStepDelays",
				]),
				fullPath,
				"feature_flags.optimize_executor_step_delays",
			) ?? false,
		optimizeTextInput:
			parseBooleanConfigValue(
				pickFirstDefined(featureFlagsSource, [
					"optimize_text_input",
					"optimizeTextInput",
				]),
				fullPath,
				"feature_flags.optimize_text_input",
			) ?? false,
	};
	const authCredentials = parseEncryptedAuthCredentialsConfig(
		pickFirstDefined(raw, ["auth_credentials", "authCredentials"]),
		fullPath,
	);
	const browserProfiles = parseBrowserProfilesConfig(
		pickFirstDefined(raw, ["browser_profiles", "browserProfiles"]),
		fullPath,
	);

	const tasksInput = pickFirstDefined(raw, ["tasks", "task"]);
	const tasks = parseConfigTasks(tasksInput, fullPath);
	if (pickFirstDefined(raw, ["default_url", "defaultUrl"]) !== undefined) {
		failConfig(
			`Invalid default_url in config: ${fullPath}. Put start URLs on task entries instead: tasks: [{ task: "...", url: "..." }].`,
		);
	}

	if (pickFirstDefined(raw, ["ports", "port"]) !== undefined) {
		failConfig(
			`Invalid ports in config: ${fullPath}. CLI configs now require 'concurrency: <positive integer>' and no longer accept 'port' or 'ports'.`,
		);
	}

	const concurrencyInput = raw.concurrency;
	if (
		typeof concurrencyInput !== "number" ||
		!Number.isInteger(concurrencyInput) ||
		concurrencyInput <= 0
	) {
		failConfig(
			`Invalid concurrency in config: ${fullPath}. Use 'concurrency: <positive integer>'.`,
		);
	}

	const waitBetweenTasksMsInput = pickFirstDefined(raw, [
		"wait_between_tasks_ms",
		"waitBetweenTasksMs",
	]);
	if (
		waitBetweenTasksMsInput !== undefined &&
		(typeof waitBetweenTasksMsInput !== "number" ||
			!Number.isFinite(waitBetweenTasksMsInput) ||
			waitBetweenTasksMsInput < 0)
	) {
		failConfig(
			`Invalid wait_between_tasks_ms value in config: ${fullPath}. Use a number >= 0.`,
		);
	}

	const taskRunsInput = pickFirstDefined(raw, ["task_runs", "taskRuns"]);
	if (
		taskRunsInput !== undefined &&
		(typeof taskRunsInput !== "number" ||
			!Number.isInteger(taskRunsInput) ||
			taskRunsInput < 1)
	) {
		failConfig(
			`Invalid task_runs value in config: ${fullPath}. Use an integer >= 1.`,
		);
	}

	const taskRunRetryCountInput = pickFirstDefined(raw, [
		"task_run_retry_count",
		"taskRunRetryCount",
	]);
	if (
		taskRunRetryCountInput !== undefined &&
		(typeof taskRunRetryCountInput !== "number" ||
			!Number.isInteger(taskRunRetryCountInput) ||
			taskRunRetryCountInput < 0)
	) {
		failConfig(
			`Invalid task_run_retry_count value in config: ${fullPath}. Use an integer >= 0.`,
		);
	}

	const taskUntilSuccessMaxAttemptsInput = pickFirstDefined(raw, [
		"task_until_success_max_attempts",
		"taskUntilSuccessMaxAttempts",
	]);
	if (
		taskUntilSuccessMaxAttemptsInput !== undefined &&
		(typeof taskUntilSuccessMaxAttemptsInput !== "number" ||
			!Number.isInteger(taskUntilSuccessMaxAttemptsInput) ||
			taskUntilSuccessMaxAttemptsInput < 1)
	) {
		failConfig(
			`Invalid task_until_success_max_attempts value in config: ${fullPath}. Use an integer >= 1.`,
		);
	}
	if (
		typeof taskUntilSuccessMaxAttemptsInput === "number" &&
		taskUntilSuccessMaxAttemptsInput > 1 &&
		typeof taskRunsInput === "number" &&
		taskRunsInput > 1
	) {
		failConfig(
			`Invalid task retry config in ${fullPath}. task_until_success_max_attempts cannot be combined with task_runs > 1.`,
		);
	}

	const headlessInput = pickFirstDefined(raw, ["headless"]);
	if (headlessInput !== undefined && typeof headlessInput !== "boolean") {
		failConfig(
			`Invalid headless value in config: ${fullPath}. Use true or false.`,
		);
	}

	const maxStepsInput = pickFirstDefined(raw, ["max_steps", "maxSteps"]);
	if (
		maxStepsInput !== undefined &&
		(typeof maxStepsInput !== "number" ||
			!Number.isInteger(maxStepsInput) ||
			maxStepsInput < 1)
	) {
		failConfig(
			`Invalid max_steps value in config: ${fullPath}. Use an integer >= 1.`,
		);
	}
	const validatorLifecycleInput = pickFirstDefined(raw, [
		"validator_lifecycle",
		"validatorLifecycle",
	]);
	let validatorLifecycle: ValidatorLifecycleOptions = {
		mode: "retry",
		maxFailures: 3,
		context: "full",
	};
	if (validatorLifecycleInput !== undefined) {
		if (
			!validatorLifecycleInput ||
			typeof validatorLifecycleInput !== "object" ||
			Array.isArray(validatorLifecycleInput)
		) {
			failConfig(
				`Invalid validator_lifecycle value in config: ${fullPath}. Use an object with mode and max_failures.`,
			);
		}
		const lifecycle = validatorLifecycleInput as Record<string, unknown>;
		const mode = pickFirstDefined(lifecycle, ["mode"]);
		const maxFailures = pickFirstDefined(lifecycle, [
			"max_failures",
			"maxFailures",
		]);
		const context = pickFirstDefined(lifecycle, ["context"]);
		if (mode !== "terminal" && mode !== "retry") {
			failConfig(
				`Invalid validator_lifecycle.mode in config: ${fullPath}. Use terminal or retry.`,
			);
		}
		if (
			maxFailures !== undefined &&
			(typeof maxFailures !== "number" ||
				!Number.isInteger(maxFailures) ||
				maxFailures < 1 ||
				maxFailures > 3)
		) {
			failConfig(
				`Invalid validator_lifecycle.max_failures in config: ${fullPath}. Use an integer from 1 to 3.`,
			);
		}
		if (context !== undefined && context !== "full" && context !== "compact") {
			failConfig(
				`Invalid validator_lifecycle.context in config: ${fullPath}. Use full or compact.`,
			);
		}
		validatorLifecycle = {
			mode,
			maxFailures: (maxFailures as number | undefined) ?? 3,
			context: (context as "full" | "compact" | undefined) ?? "full",
		};
	}

	const downloadDirInput = pickFirstDefined(raw, [
		"download_dir",
		"downloadDir",
	]);
	const fileWorkspaceRootInput = pickFirstDefined(raw, [
		"file_workspace_root",
		"fileWorkspaceRoot",
	]);
	const executablePathInput = pickFirstDefined(raw, [
		"executable_path",
		"executablePath",
	]);
	if (
		downloadDirInput !== undefined &&
		(typeof downloadDirInput !== "string" || !downloadDirInput.trim())
	) {
		failConfig(
			`Invalid download_dir value in config: ${fullPath}. Use a non-empty directory path string.`,
		);
	}
	if (
		fileWorkspaceRootInput !== undefined &&
		(typeof fileWorkspaceRootInput !== "string" ||
			!fileWorkspaceRootInput.trim())
	) {
		failConfig(
			`Invalid file_workspace_root value in config: ${fullPath}. Use a non-empty directory path string.`,
		);
	}
	if (
		executablePathInput !== undefined &&
		(typeof executablePathInput !== "string" || !executablePathInput.trim())
	) {
		failConfig(
			`Invalid executable_path value in config: ${fullPath}. Use a non-empty Chrome executable path string.`,
		);
	}

	const explicitDownloadDir =
		typeof downloadDirInput === "string" && downloadDirInput.trim()
			? downloadDirInput.trim()
			: undefined;
	const explicitFileWorkspaceRoot =
		typeof fileWorkspaceRootInput === "string" && fileWorkspaceRootInput.trim()
			? fileWorkspaceRootInput.trim()
			: undefined;
	const normalizedDownloadDir =
		explicitDownloadDir ??
		(explicitFileWorkspaceRoot
			? path.join(explicitFileWorkspaceRoot, "downloads")
			: undefined);
	const normalizedFileWorkspaceRoot =
		explicitFileWorkspaceRoot ?? normalizedDownloadDir;

	const proxyHostInput = pickFirstDefined(raw, ["proxy_host", "proxyHost"]);
	const proxyPortInput = pickFirstDefined(raw, ["proxy_port", "proxyPort"]);
	const hasProxyHost = proxyHostInput !== undefined;
	const hasProxyPort = proxyPortInput !== undefined;
	if (hasProxyHost !== hasProxyPort) {
		failConfig(
			`Invalid proxy config in ${fullPath}. Provide proxy_host and proxy_port together.`,
		);
	}
	if (
		hasProxyHost &&
		(typeof proxyHostInput !== "string" || !proxyHostInput.trim())
	) {
		failConfig(
			`Invalid proxy_host value in config: ${fullPath}. Use a non-empty string.`,
		);
	}
	if (
		hasProxyPort &&
		(typeof proxyPortInput !== "number" ||
			!Number.isInteger(proxyPortInput) ||
			proxyPortInput <= 0)
	) {
		failConfig(
			`Invalid proxy_port value in config: ${fullPath}. Use a positive integer.`,
		);
	}

	const saveStepsContextInput = pickFirstDefined(raw, [
		"save_steps_context",
		"saveStepsContext",
	]);
	if (
		saveStepsContextInput !== undefined &&
		typeof saveStepsContextInput !== "boolean"
	) {
		failConfig(
			`Invalid save_steps_context value in config: ${fullPath}. Use true or false.`,
		);
	}

	const saveTaskLogsInput = pickFirstDefined(raw, [
		"save_task_logs",
		"saveTaskLogs",
	]);
	if (
		saveTaskLogsInput !== undefined &&
		typeof saveTaskLogsInput !== "boolean"
	) {
		failConfig(
			`Invalid save_task_logs value in config: ${fullPath}. Use true or false.`,
		);
	}

	const stepMessagesJsonlPathInput = pickFirstDefined(raw, [
		"step_messages_jsonl_path",
		"stepMessagesJsonlPath",
	]);
	if (
		stepMessagesJsonlPathInput !== undefined &&
		typeof stepMessagesJsonlPathInput !== "string"
	) {
		failConfig(
			`Invalid step_messages_jsonl_path value in config: ${fullPath}. Use a file path string.`,
		);
	}

	const taskExecutionOverridesPathInput = pickFirstDefined(raw, [
		"task_execution_overrides_path",
		"taskExecutionOverridesPath",
	]);
	if (
		taskExecutionOverridesPathInput !== undefined &&
		(typeof taskExecutionOverridesPathInput !== "string" ||
			!taskExecutionOverridesPathInput.trim())
	) {
		failConfig(
			`Invalid task_execution_overrides_path value in config: ${fullPath}. Use a non-empty file path string.`,
		);
	}

	return {
		stageLLMs,
		featureFlags: configuredFeatureFlags,
		authCredentials,
		browserProfiles,
		headless: (headlessInput as boolean | undefined) ?? false,
		maxSteps: (maxStepsInput as number | undefined) ?? 50,
		validatorLifecycle,
		downloadDir: normalizedDownloadDir,
		fileWorkspaceRoot: normalizedFileWorkspaceRoot,
		executablePath:
			typeof executablePathInput === "string"
				? path.resolve(executablePathInput.trim())
				: undefined,
		proxy:
			hasProxyHost && hasProxyPort
				? {
						host: (proxyHostInput as string).trim(),
						port: proxyPortInput as number,
					}
				: undefined,
		waitBetweenTasksMs: (waitBetweenTasksMsInput as number | undefined) ?? 0,
		taskRuns: (taskRunsInput as number | undefined) ?? 1,
		taskRunRetryCount: (taskRunRetryCountInput as number | undefined) ?? 0,
		taskUntilSuccessMaxAttempts: taskUntilSuccessMaxAttemptsInput as
			number | undefined,
		tasks,
		concurrency: concurrencyInput,
		saveStepsContext: (saveStepsContextInput as boolean | undefined) ?? true,
		saveTaskLogs: (saveTaskLogsInput as boolean | undefined) ?? false,
		stepMessagesJsonlPath:
			typeof stepMessagesJsonlPathInput === "string" &&
			stepMessagesJsonlPathInput.trim()
				? stepMessagesJsonlPathInput.trim()
				: path.join(os.tmpdir(), "browser-agent", "context", "steps.jsonl"),
		taskExecutionOverridesPath:
			typeof taskExecutionOverridesPathInput === "string" &&
			taskExecutionOverridesPathInput.trim()
				? resolveConfigRelativePath(
						taskExecutionOverridesPathInput.trim(),
						fullPath,
					)
				: undefined,
	};
}

export function parseArgs(argv: string[]): CLIArgs {
	const args = argv.slice(2);
	if (args[0] === "codex-login") {
		if (args.length > 2 || (args.length === 2 && args[1] !== "--check")) {
			throw new Error(
				"The codex-login command only accepts the optional --check flag.",
			);
		}
		return {
			codexLogin: true,
			codexLoginCheck: args[1] === "--check",
			help: false,
			rpc: false,
			version: false,
			versionJson: false,
		};
	}
	if (args[0] === "generate-key") {
		if (args.length !== 1) {
			throw new Error("The generate-key command does not accept arguments.");
		}
		return {
			generateKey: true,
			help: false,
			rpc: false,
			version: false,
			versionJson: false,
		};
	}
	if (args[0] === "encrypt") {
		if (args.length !== 2) {
			throw new Error(
				'The encrypt command expects exactly one value: browser-agent encrypt "value-to-encrypt".',
			);
		}
		if (!args[1].trim()) {
			throw new Error("The encrypt command requires a non-empty value.");
		}
		return {
			encryptValue: args[1],
			help: false,
			rpc: false,
			version: false,
			versionJson: false,
		};
	}
	const positional: string[] = [];
	let help = false;
	let rpc = false;
	let version = false;
	let versionJson = false;

	for (const arg of args) {
		switch (arg) {
			case "-h":
			case "--help":
				help = true;
				break;
			case "--rpc":
				rpc = true;
				break;
			case "-V":
			case "--version":
				version = true;
				break;
			case "--version-json":
				versionJson = true;
				break;
			default:
				if (arg.startsWith("-")) {
					throw new Error(`Unknown option: ${arg}`);
				}
				positional.push(arg);
		}
	}

	if (positional.length > 1) {
		throw new Error(
			`Expected one config path, received ${positional.length}: ${positional.join(
				", ",
			)}`,
		);
	}

	return {
		config: positional[0],
		help,
		rpc,
		version,
		versionJson,
	};
}

export async function prompt(question: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) =>
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		}),
	);
}

export function formatTokenCount(value: number, width = 9): string {
	return String(value).padStart(width);
}

function getRecapOutputUsage(usage: {
	reasoning_tokens?: number;
	non_reasoning_output_tokens?: number;
	output_tokens: number;
}): { reasoning?: number; output?: number } {
	if (
		!("reasoning_tokens" in usage) &&
		!("non_reasoning_output_tokens" in usage)
	) {
		return { reasoning: 0, output: usage.output_tokens };
	}
	return {
		reasoning: usage.reasoning_tokens,
		output: usage.non_reasoning_output_tokens,
	};
}

export function reportExecution(
	result: string,
	steps: number,
	tokenUsage: StepTokenUsage[],
	successful: boolean,
	successVerification?: SuccessVerificationResult,
	stepRuntimeMetrics: StepRuntimeMetrics[] = [],
	extractionStepUsage: ExtractionStepUsage[] = [],
	stageUsage: RecapStageUsage[] = [],
): void {
	console.log("\n" + "=".repeat(60));
	console.log(
		`RESULT (${steps} steps, success=${successful ? "true" : "false"}):`,
	);
	console.log("=".repeat(60));
	console.log(result);
	console.log("=".repeat(60));
	if (successVerification) {
		console.log("\nSUCCESS VERIFICATION:");
		console.log("-".repeat(62));
		console.log(
			`${successVerification.success ? "PASS" : "FAIL"} | ${successVerification.summary}`,
		);
		if (successVerification.reasons.length > 0) {
			for (const reason of successVerification.reasons) {
				console.log(`- ${reason}`);
			}
		}
		console.log("-".repeat(62));
	}

	const stageCounts = new Map<string, number>();
	for (const stage of stageUsage) {
		const key = `${stage.phase}:${stage.stage}`;
		stageCounts.set(key, (stageCounts.get(key) ?? 0) + 1);
	}
	const stageIndexes = new Map<string, number>();
	const labeledStageUsage = stageUsage.map((stage) => {
		const key = `${stage.phase}:${stage.stage}`;
		const index = (stageIndexes.get(key) ?? 0) + 1;
		stageIndexes.set(key, index);
		const baseLabel = `${stage.phase} / ${stage.stage}`;
		return {
			...stage,
			label:
				(stageCounts.get(key) ?? 0) > 1 ? `${baseLabel} #${index}` : baseLabel,
		};
	});
	const extractionLabels = extractionStepUsage.map((extraction) => {
		const siblingCount = extractionStepUsage.filter(
			(sibling) => sibling.parentStep === extraction.parentStep,
		).length;
		return siblingCount > 1
			? `  ↳ extract_data #${extraction.extractionIndex}`
			: "  ↳ extract_data";
	});
	const recapLabelWidth = Math.max(
		22,
		...labeledStageUsage.map(({ label }) => label.length),
		...extractionLabels.map((label) => label.length),
	);
	const recapHeader = `${"Step / Substep".padEnd(recapLabelWidth)} | Input     | Cache Read | Cache Write | Reasoning | Output    | Total     | LLM Time (s) | Step Time (s)`;
	const recapDivider = "-".repeat(recapHeader.length);
	const runtimeMetricsByStep = new Map(
		stepRuntimeMetrics.map((metrics) => [metrics.stepNumber, metrics]),
	);
	const extractionUsageByParent = new Map<number, ExtractionStepUsage[]>();
	for (const extraction of extractionStepUsage) {
		const siblings = extractionUsageByParent.get(extraction.parentStep) ?? [];
		siblings.push(extraction);
		extractionUsageByParent.set(extraction.parentStep, siblings);
	}

	console.log("\nRECAP:");
	console.log(recapDivider);
	console.log(recapHeader);
	console.log(recapDivider);

	let totalInput = 0,
		totalCachedInput = 0,
		totalCacheWrite = 0,
		totalReasoning = 0,
		totalOutput = 0,
		totalTokens = 0,
		totalLlmTimeMs = 0,
		totalStepTimeMs = 0;

	const printStageRow = (stage: (typeof labeledStageUsage)[number]) => {
		if (!stage.usage) {
			const unavailable = "—".padStart(9);
			console.log(
				`${stage.label.padEnd(recapLabelWidth)} | ${unavailable} | ${unavailable} | ${unavailable} | ${unavailable} | ${unavailable} | ${unavailable} | ${"—".padStart(12)} | ${"—".padStart(13)}`,
			);
			return;
		}
		const cachedInput = stage.usage.cached_input_tokens;
		const cacheWrite = stage.usage.cache_write_tokens;
		const { reasoning, output } = getRecapOutputUsage(stage.usage);
		const llmTimeMs = stage.usage.generation_time_ms;
		console.log(
			`${stage.label.padEnd(recapLabelWidth)} | ${formatTokenCount(stage.usage.input_tokens)} | ${typeof cachedInput === "number" ? formatTokenCount(cachedInput) : "—".padStart(9)} | ${typeof cacheWrite === "number" ? formatTokenCount(cacheWrite) : "—".padStart(11)} | ${typeof reasoning === "number" ? formatTokenCount(reasoning) : "—".padStart(9)} | ${typeof output === "number" ? formatTokenCount(output) : "—".padStart(9)} | ${formatTokenCount(stage.usage.total_tokens)} | ${typeof llmTimeMs === "number" ? (llmTimeMs / 1000).toFixed(2).padStart(12) : "—".padStart(12)} | ${"—".padStart(13)}`,
		);
		totalInput += stage.usage.input_tokens;
		totalCachedInput += cachedInput ?? 0;
		totalCacheWrite += cacheWrite ?? 0;
		totalReasoning += reasoning ?? 0;
		totalOutput += output ?? 0;
		totalTokens += stage.usage.total_tokens;
		totalLlmTimeMs += llmTimeMs ?? 0;
	};

	for (const stage of labeledStageUsage) {
		if (stage.phase === "preprocess") printStageRow(stage);
	}

	for (const t of tokenUsage) {
		const cachedInput = t.cached_input_tokens ?? 0;
		const cacheWrite = t.cache_write_tokens ?? 0;
		const { reasoning, output } = getRecapOutputUsage(t);
		const runtimeMetrics = runtimeMetricsByStep.get(t.step);
		const llmTimeMs = runtimeMetrics?.tokenGenerationMs ?? 0;
		const stepTimeMs = runtimeMetrics?.totalDurationMs ?? 0;
		console.log(
			`${String(t.step).padStart(4).padEnd(recapLabelWidth)} | ${formatTokenCount(t.input_tokens)} | ${formatTokenCount(cachedInput)} | ${formatTokenCount(cacheWrite, 11)} | ${typeof reasoning === "number" ? formatTokenCount(reasoning) : "—".padStart(9)} | ${typeof output === "number" ? formatTokenCount(output) : "—".padStart(9)} | ${formatTokenCount(t.total_tokens)} | ${(llmTimeMs / 1000).toFixed(2).padStart(12)} | ${(stepTimeMs / 1000).toFixed(2).padStart(13)}`,
		);
		const extractions = extractionUsageByParent.get(t.step) ?? [];
		for (const extraction of extractions) {
			const extractionLabel =
				extractions.length > 1
					? `  ↳ extract_data #${extraction.extractionIndex}`
					: "  ↳ extract_data";
			const extractionCachedInput = extraction.usage.cached_input_tokens ?? 0;
			const extractionCacheWrite = extraction.usage.cache_write_tokens ?? 0;
			const { reasoning: extractionReasoning, output: extractionOutput } =
				getRecapOutputUsage(extraction.usage);
			const extractionLlmTimeMs = extraction.usage.generation_time_ms ?? 0;
			console.log(
				`${extractionLabel.padEnd(recapLabelWidth)} | ${formatTokenCount(extraction.usage.input_tokens)} | ${formatTokenCount(extractionCachedInput)} | ${formatTokenCount(extractionCacheWrite, 11)} | ${typeof extractionReasoning === "number" ? formatTokenCount(extractionReasoning) : "—".padStart(9)} | ${typeof extractionOutput === "number" ? formatTokenCount(extractionOutput) : "—".padStart(9)} | ${formatTokenCount(extraction.usage.total_tokens)} | ${(extractionLlmTimeMs / 1000).toFixed(2).padStart(12)} | ${"—".padStart(13)}`,
			);
		}
		totalInput += t.input_tokens;
		totalCachedInput += cachedInput;
		totalCacheWrite += cacheWrite;
		totalReasoning += reasoning ?? 0;
		totalOutput += output ?? 0;
		totalTokens += t.total_tokens;
		totalLlmTimeMs += llmTimeMs;
		totalStepTimeMs += stepTimeMs;
	}

	for (const stage of labeledStageUsage) {
		if (stage.phase === "verification") printStageRow(stage);
	}

	console.log(recapDivider);
	console.log(
		`${"Total".padEnd(recapLabelWidth)} | ${formatTokenCount(totalInput)} | ${formatTokenCount(totalCachedInput)} | ${formatTokenCount(totalCacheWrite, 11)} | ${formatTokenCount(totalReasoning)} | ${formatTokenCount(totalOutput)} | ${formatTokenCount(totalTokens)} | ${(totalLlmTimeMs / 1000).toFixed(2).padStart(12)} | ${(totalStepTimeMs / 1000).toFixed(2).padStart(13)}`,
	);
	console.log(recapDivider);
	if (extractionStepUsage.length > 0) {
		console.log("Extraction subrows are excluded from Total.");
	}
}
