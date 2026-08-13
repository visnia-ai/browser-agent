import { createHash } from "node:crypto";
import type { ConfigFeatureFlags } from "../config-feature-flags.js";
import type {
	ContentPart,
	ExecutorContextPolicy,
	Message,
	MessageProviderOptions,
	OpenAIPromptCacheRequest,
} from "./types.js";
import {
	customToolPublicMetadata,
	type CustomToolRegistry,
} from "../custom-tools.js";

export const OPENAI_PROMPT_CACHE_SCHEMA_VERSION =
	"executor-explicit-cache-v2";
export const OPENAI_CURRENT_STEP_MARKER = "BEGIN CURRENT STEP";

export function createOpenAIPromptCacheBreakpointOptions(): MessageProviderOptions {
	return {
		openai: {
			promptCacheBreakpoint: { mode: "explicit" },
		},
	};
}

export function createOpenAICacheMarkerPart(): ContentPart {
	return {
		type: "text",
		text: OPENAI_CURRENT_STEP_MARKER,
		providerOptions: createOpenAIPromptCacheBreakpointOptions(),
	};
}

export function createOpenAIStableStepMarkerPart(): ContentPart {
	return {
		type: "text",
		text: OPENAI_CURRENT_STEP_MARKER,
	};
}

export function createOpenAICachedUserContent(
	text: string,
	trailingParts: ContentPart[] = [],
): ContentPart[] {
	return [
		createOpenAICacheMarkerPart(),
		{ type: "text", text },
		...trailingParts,
	];
}

export function createOpenAIStableStepUserContent(text: string): ContentPart[] {
	return [
		createOpenAIStableStepMarkerPart(),
		{ type: "text", text },
	];
}

export function createOpenAICachedSystemMessage(content: string): Message {
	return {
		role: "system",
		content,
		providerOptions: createOpenAIPromptCacheBreakpointOptions(),
	};
}

export function isOpenAICacheMarkerPart(part: ContentPart): boolean {
	return (
		part.type === "text" &&
		part.text === OPENAI_CURRENT_STEP_MARKER &&
		part.providerOptions?.openai?.promptCacheBreakpoint !== undefined
	);
}

export function buildOpenAIPromptCacheRequest(input: {
	model: string;
	shard: string;
	featureFlags: ConfigFeatureFlags;
	executorContextPolicy: Readonly<ExecutorContextPolicy>;
	customTools?: CustomToolRegistry;
}): OpenAIPromptCacheRequest {
	const customTools = customToolPublicMetadata(input.customTools);
	const fingerprint = JSON.stringify({
		provider: "openai",
		model: input.model,
		promptSchemaVersion: OPENAI_PROMPT_CACHE_SCHEMA_VERSION,
		featureFlags: input.featureFlags,
		executorContextPolicy: input.executorContextPolicy,
		...(customTools.length > 0 ? { customTools } : {}),
		shard: input.shard,
	});
	const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
	return {
		promptCacheKey: `browser-agent:${digest}`,
		promptCacheOptions: { mode: "explicit", ttl: "30m" },
	};
}

export function buildOpenAIExplicitNoCacheRequest(): OpenAIPromptCacheRequest {
	return {
		promptCacheOptions: { mode: "explicit", ttl: "30m" },
	};
}
