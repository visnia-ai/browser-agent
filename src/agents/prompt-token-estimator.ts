import { encoding_for_model } from "tiktoken";

const PROMPT_TOKEN_ESTIMATE_MODEL = "gpt-5";

let promptTokenEncoding: ReturnType<typeof encoding_for_model> | null = null;

export function estimateTokenCount(text: string): number {
	try {
		if (!promptTokenEncoding) {
			promptTokenEncoding = encoding_for_model(
				PROMPT_TOKEN_ESTIMATE_MODEL,
			);
		}
		return promptTokenEncoding.encode(text).length;
	} catch {
		return Math.max(1, Math.ceil(text.length / 4));
	}
}
