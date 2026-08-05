import type { LLMOptions } from "../agents/types.js";
import type { PreprocessStageLLMs } from "../core/types.js";
import type { Config, StageLLMOptions } from "../utils.js";

export const SEMANTIC_PROJECTION_HISTORY_ENV =
	"BROWSER_AGENT_SEMANTIC_PROJECTION_HISTORY";

function readEnvString(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveLLMOptionsFromEnv(options: LLMOptions): LLMOptions {
	if (options.provider !== "vllm") {
		return options;
	}
	return {
		...options,
		endpointUrl: options.endpointUrl || readEnvString("VLLM_BASE_URL"),
	};
}

export function resolvePreprocessStageLLMsFromEnv(
	stageLLMs: PreprocessStageLLMs,
): PreprocessStageLLMs {
	return {
		findTargetURL: resolveLLMOptionsFromEnv(stageLLMs.findTargetURL),
		createChecklist: resolveLLMOptionsFromEnv(stageLLMs.createChecklist),
	};
}

export function resolveStageLLMsFromEnv(
	stageLLMs: StageLLMOptions,
): StageLLMOptions {
	return {
		findTargetURL: resolveLLMOptionsFromEnv(stageLLMs.findTargetURL),
		createChecklist: resolveLLMOptionsFromEnv(stageLLMs.createChecklist),
		runAgent: resolveLLMOptionsFromEnv(stageLLMs.runAgent),
		dataExtraction: resolveLLMOptionsFromEnv(stageLLMs.dataExtraction),
		verifySuccess: resolveLLMOptionsFromEnv(stageLLMs.verifySuccess),
	};
}

export function resolveConfigFromEnv(config: Config): Config {
	const semanticProjectionHistory = readEnvString(
		SEMANTIC_PROJECTION_HISTORY_ENV,
	);
	if (
		semanticProjectionHistory !== undefined &&
		semanticProjectionHistory !== "current" &&
		semanticProjectionHistory !== "cumulative"
	) {
		throw new Error(
			`${SEMANTIC_PROJECTION_HISTORY_ENV} must be "current" or "cumulative".`,
		);
	}
	return {
		...config,
		stageLLMs: resolveStageLLMsFromEnv(config.stageLLMs),
		featureFlags: {
			...config.featureFlags,
			...(semanticProjectionHistory ? { semanticProjectionHistory } : {}),
		},
	};
}
