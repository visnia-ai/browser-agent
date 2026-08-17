import yaml from "js-yaml";
import type { AssistantModelMessage, ModelMessage } from "ai";
import { userMessage } from "../agents/providers/router.js";
import { serializeModelOutputForHistory } from "../agents/executor-utils/step-execution.js";
import type { StepHistoryEntry } from "./types.js";
import { stripProjectionContextFromHistoryPayload } from "../agents/executor-utils/history-payload.js";
import type { ExecutorPromptOptions } from "../agents/prompts.js";
import {
	createOpenAICachedUserContent,
	createOpenAIStableStepUserContent,
} from "../agents/openai-prompt-cache.js";

export function buildHistoryMessagesFromFullStepHistory(
	stepsHistory: StepHistoryEntry[],
	options: ExecutorPromptOptions = {},
	historyOptions: {
		omitProjectionContext?: boolean;
		openAIExplicitPromptCaching?: boolean;
	} = {},
): ModelMessage[] {
	const messages: ModelMessage[] = [];

	for (const [index, step] of stepsHistory.entries()) {
		const payload = { ...step.payload };
		if (historyOptions.omitProjectionContext) {
			stripProjectionContextFromHistoryPayload(payload);
		}
		delete payload.validRefs;
		delete payload.plan;
		const payloadText = yaml.dump(payload);
		const isImmediatelyPreviousStep = index === stepsHistory.length - 1;
		messages.push(
			userMessage(
				historyOptions.openAIExplicitPromptCaching
					? isImmediatelyPreviousStep
						? createOpenAICachedUserContent(payloadText)
						: createOpenAIStableStepUserContent(payloadText)
					: payloadText,
			),
		);
		messages.push(
			...sanitizeAcceptedResponseMessages(
				step,
				options.executorContextPolicy?.includeReasoningHistory ?? true,
			),
		);
	}

	return messages;
}

/**
 * Preserve native response parts and provider metadata while replacing only the
 * final assistant text with the accepted, policy-sanitized history text.
 */
export function sanitizeAcceptedResponseMessages(
	step: StepHistoryEntry,
	includeReasoningHistory = true,
): ModelMessage[] {
	const assistantText = serializeModelOutputForHistory(step.assistant);
	let finalAssistantIndex = -1;
	for (let index = step.responseMessages.length - 1; index >= 0; index--) {
		if (step.responseMessages[index]?.role === "assistant") {
			finalAssistantIndex = index;
			break;
		}
	}
	if (finalAssistantIndex < 0) {
		return [{ role: "assistant", content: assistantText }];
	}

	return step.responseMessages.map((message, index): ModelMessage => {
		if (index !== finalAssistantIndex || message.role !== "assistant") {
			return message.role === "assistant"
				? sanitizeAssistantReasoningHistory(message, includeReasoningHistory)
				: message;
		}
		if (typeof message.content === "string") {
			return sanitizeAssistantReasoningHistory(
				{ ...message, content: assistantText },
				includeReasoningHistory,
			);
		}

		let replacedText = false;
		const content: Exclude<AssistantModelMessage["content"], string> = [];
		for (const part of message.content) {
			if (part.type !== "text") {
				content.push(part);
				continue;
			}
			if (replacedText) continue;
			replacedText = true;
			const { openai: _staleOpenAITextState, ...providerOptions } =
				part.providerOptions ?? {};
			content.push({
				type: "text",
				text: assistantText,
				...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
			});
		}
		if (!replacedText) {
			content.push({ type: "text", text: assistantText });
		}
		return sanitizeAssistantReasoningHistory(
			{ ...message, content } as AssistantModelMessage,
			includeReasoningHistory,
		);
	});
}

const REASONING_METADATA_KEYS = new Set([
	"encrypted_content",
	"reasoning_details",
	"reasoning_encrypted_content",
	"reasoningdetails",
	"reasoningencryptedcontent",
	"redacteddata",
	"signature",
	"thoughtsignature",
]);

function stripReasoningMetadata(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripReasoningMetadata);
	}
	if (typeof value !== "object" || value === null) return value;

	const stripped: Record<string, unknown> = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase();
		if (REASONING_METADATA_KEYS.has(normalizedKey)) continue;
		const sanitizedValue = stripReasoningMetadata(nestedValue);
		if (
			typeof sanitizedValue === "object" &&
			sanitizedValue !== null &&
			!Array.isArray(sanitizedValue) &&
			Object.keys(sanitizedValue).length === 0
		) {
			continue;
		}
		stripped[key] = sanitizedValue;
	}
	return stripped;
}

function sanitizeAssistantReasoningHistory(
	message: AssistantModelMessage,
	includeReasoningHistory: boolean,
): AssistantModelMessage {
	if (includeReasoningHistory) return message;

	const providerOptions = stripReasoningMetadata(message.providerOptions) as
		AssistantModelMessage["providerOptions"] | undefined;
	const {
		providerOptions: _originalProviderOptions,
		...messageWithoutProviderOptions
	} = message;
	if (typeof message.content === "string") {
		return {
			...messageWithoutProviderOptions,
			...(providerOptions && Object.keys(providerOptions).length > 0
				? { providerOptions }
				: {}),
		};
	}

	const content = message.content
		.filter(
			(part) => part.type !== "reasoning" && part.type !== "reasoning-file",
		)
		.map((part) => {
			if (!("providerOptions" in part)) return part;
			const {
				providerOptions: _originalPartProviderOptions,
				...partWithoutProviderOptions
			} = part;
			const sanitizedProviderOptions = stripReasoningMetadata(
				part.providerOptions,
			) as AssistantModelMessage["providerOptions"];
			return {
				...partWithoutProviderOptions,
				...(sanitizedProviderOptions &&
				Object.keys(sanitizedProviderOptions).length > 0
					? { providerOptions: sanitizedProviderOptions }
					: {}),
			};
		});

	return {
		...messageWithoutProviderOptions,
		content,
		...(providerOptions && Object.keys(providerOptions).length > 0
			? { providerOptions }
			: {}),
	};
}
