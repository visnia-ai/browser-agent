import { createHash } from "node:crypto";
import type { UserContent } from "ai";
import type { ConfigFeatureFlags } from "../config-feature-flags.js";
import type {
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

type UserContentPart = Exclude<UserContent, string>[number];

export function createOpenAIPromptCacheBreakpointOptions(): MessageProviderOptions {
	return {
		openai: {
			promptCacheBreakpoint: { mode: "explicit" },
		},
	};
}

export function createOpenAICacheMarkerPart(): UserContentPart {
	return {
		type: "text",
		text: OPENAI_CURRENT_STEP_MARKER,
		providerOptions: createOpenAIPromptCacheBreakpointOptions(),
	};
}

export function createOpenAIStableStepMarkerPart(): UserContentPart {
	return {
		type: "text",
		text: OPENAI_CURRENT_STEP_MARKER,
	};
}

export function createOpenAICachedUserContent(
	text: string,
	trailingParts: UserContentPart[] = [],
): UserContent {
	return [
		createOpenAICacheMarkerPart(),
		{ type: "text", text },
		...trailingParts,
	];
}

export function createOpenAIStableStepUserContent(text: string): UserContent {
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

export function isOpenAICacheMarkerPart(part: unknown): boolean {
	return (
		typeof part === "object" &&
		part !== null &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		part.text === OPENAI_CURRENT_STEP_MARKER &&
		"providerOptions" in part &&
		typeof part.providerOptions === "object" &&
		part.providerOptions !== null &&
		"openai" in part.providerOptions &&
		typeof part.providerOptions.openai === "object" &&
		part.providerOptions.openai !== null &&
		"promptCacheBreakpoint" in part.providerOptions.openai
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
