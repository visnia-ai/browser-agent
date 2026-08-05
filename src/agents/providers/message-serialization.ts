import yaml from "js-yaml";
import type { Message } from "../types.js";

export function messageContentToText(content: Message["content"]): string {
	return typeof content === "string"
		? content
		: content
				.map((part) =>
					part.type === "text" ? part.text : "[image omitted]",
				)
				.join("\n");
}

export function toCompletionPrompt(messages: Message[]): string {
	return messages
		.map((message) => {
			const contentText = messageContentToText(message.content);
			const reasoningTokens =
				message.role === "assistant"
					? message.reasoning_tokens?.trim()
					: undefined;
			const reasoningPrefix = reasoningTokens
				? yaml
						.dump(
							{ reasoning_tokens: reasoningTokens },
							{ lineWidth: -1, noRefs: true },
						)
						.trimEnd() + "\n"
				: "";
			return `${message.role.toUpperCase()}:\n${reasoningPrefix}${contentText}`;
		})
		.join("\n\n");
}
