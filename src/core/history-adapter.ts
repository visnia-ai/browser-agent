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
	_options: ExecutorPromptOptions = {},
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
		messages.push(...sanitizeAcceptedResponseMessages(step));
	}

	return messages;
}

/**
 * Preserve native response parts and provider metadata while replacing only the
 * final assistant text with the accepted, policy-sanitized history text.
 */
export function sanitizeAcceptedResponseMessages(
	step: StepHistoryEntry,
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
			return message;
		}
		if (typeof message.content === "string") {
			return { ...message, content: assistantText };
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
		return { ...message, content } as ModelMessage;
	});
}
