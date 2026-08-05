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

export function buildHistoryMessagesFromFullStepHistory(
	stepsHistory: StepHistoryEntry[],
	_options: ExecutorPromptOptions = {},
	historyOptions: {
		omitProjectionContext?: boolean;
	} = {},
): Message[] {
	const messages: Message[] = [];

	for (const step of stepsHistory) {
		const payload = { ...step.payload };
		if (historyOptions.omitProjectionContext) {
			stripProjectionContextFromHistoryPayload(payload);
		}
		delete payload.validRefs;
		delete payload.plan;
		messages.push(userMessage(yaml.dump(payload)));
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
