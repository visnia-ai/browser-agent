import yaml from "js-yaml";
import type { Message } from "../agents/types.js";
import { userMessage } from "../agents/providers/router.js";
import { serializeModelOutputForHistory } from "../agents/executor-utils/step-execution.js";
import type { StepHistoryEntry } from "./types.js";
import { stripProjectionContextFromHistoryPayload } from "../agents/executor-utils/history-payload.js";
import {
	shouldIncludeExecutorReasoningHistory,
	type ExecutorPromptOptions,
} from "../agents/prompts.js";
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
): Message[] {
	const messages: Message[] = [];

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
		const reasoningTokens = shouldIncludeExecutorReasoningHistory()
			? step.reasoningTokens?.trim()
			: undefined;
		messages.push({
			role: "assistant",
			content: serializeModelOutputForHistory(step.assistant),
			...(reasoningTokens ? { reasoning_tokens: reasoningTokens } : {}),
		});
	}

	return messages;
}
