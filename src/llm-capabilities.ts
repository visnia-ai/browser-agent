export const SUPPORTED_PROVIDERS = [
	"openai",
	"vllm",
	"together",
	"anthropic",
	"google",
	"openrouter",
] as const;

export type Provider = (typeof SUPPORTED_PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
	return (
		typeof value === "string" &&
		(SUPPORTED_PROVIDERS as readonly string[]).includes(value)
	);
}

const OPENAI_REASONING_EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
] as const;
const GPT_5_6_REASONING_EFFORTS = [
	...OPENAI_REASONING_EFFORTS,
	"xhigh",
	"max",
] as const;
const TOGETHER_GLM_REASONING_EFFORTS = ["none", "high", "max"] as const;
const TOGGLE_REASONING_EFFORTS = ["none", "enabled"] as const;
const DISABLED_REASONING_EFFORTS = ["none"] as const;
export const OPENROUTER_REASONING_EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

interface ReasoningModelCapabilityDefinition {
	provider: Provider;
	model: string;
	match: "exact" | "contains";
	reasoningEfforts: readonly string[];
	defaultReasoningEffort: string;
}

export const REASONING_MODEL_CAPABILITIES = [
	...["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"].map((model) => ({
		provider: "openai" as const,
		model,
		match: "exact" as const,
		reasoningEfforts: OPENAI_REASONING_EFFORTS,
		defaultReasoningEffort: "low" as const,
	})),
	...["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].map((model) => ({
		provider: "openai" as const,
		model,
		match: "exact" as const,
		reasoningEfforts: GPT_5_6_REASONING_EFFORTS,
		defaultReasoningEffort: "low" as const,
	})),
	{
		provider: "together",
		model: "zai-org/GLM-5.2",
		match: "exact",
		reasoningEfforts: TOGETHER_GLM_REASONING_EFFORTS,
		defaultReasoningEffort: "high",
	},
	{
		provider: "vllm",
		model: "qwen",
		match: "contains",
		reasoningEfforts: TOGGLE_REASONING_EFFORTS,
		defaultReasoningEffort: "enabled",
	},
	{
		provider: "vllm",
		model: "glm",
		match: "contains",
		reasoningEfforts: TOGETHER_GLM_REASONING_EFFORTS,
		defaultReasoningEffort: "none",
	},
	{
		provider: "vllm",
		model: "deepseek-ai/DeepSeek-V4-Flash-0731",
		match: "exact",
		reasoningEfforts: TOGETHER_GLM_REASONING_EFFORTS,
		defaultReasoningEffort: "high",
	},
] as const satisfies readonly ReasoningModelCapabilityDefinition[];

export type ReasoningModelCapability =
	(typeof REASONING_MODEL_CAPABILITIES)[number];

export type ReasoningEffort =
	| ReasoningModelCapability["reasoningEfforts"][number]
	| (typeof OPENROUTER_REASONING_EFFORTS)[number];

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
	...new Set([
		...OPENROUTER_REASONING_EFFORTS,
		...REASONING_MODEL_CAPABILITIES.flatMap((capability) => [
			...capability.reasoningEfforts,
		]),
	] as ReasoningEffort[]),
];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return (
		typeof value === "string" &&
		(REASONING_EFFORTS as readonly string[]).includes(value)
	);
}
