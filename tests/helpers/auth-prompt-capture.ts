import { assert } from "chai";

export interface CapturedOpenAIPromptCall {
	body: Record<string, unknown>;
	promptText: string;
	serializedBody: string;
}

function collectStringLeaves(value: unknown, output: string[]): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectStringLeaves(entry, output);
		}
		return;
	}
	if (!value || typeof value !== "object") {
		return;
	}
	for (const entry of Object.values(value as Record<string, unknown>)) {
		collectStringLeaves(entry, output);
	}
}

export function extractPromptTextFromOpenAIInput(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	const strings: string[] = [];
	collectStringLeaves(input, strings);
	return strings.join("\n");
}

export function createCapturedOpenAIClient(params: {
	respond: (call: CapturedOpenAIPromptCall, callIndex: number) => string;
}) {
	const calls: CapturedOpenAIPromptCall[] = [];

	return {
		calls,
		client: {
			responses: {
				create: async (body: Record<string, unknown>) => {
					const call: CapturedOpenAIPromptCall = {
						body,
						promptText: extractPromptTextFromOpenAIInput(
							body.input,
						),
						serializedBody: JSON.stringify(body),
					};
					calls.push(call);
					return {
						output_text: params.respond(call, calls.length - 1),
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							total_tokens: 0,
							input_tokens_details: {
								cached_tokens: 0,
							},
						},
					};
				},
				inputTokens: {
					count: async () => ({
						object: "response.input_tokens",
						input_tokens: 0,
					}),
				},
			},
		},
	};
}

export function assertNoSecretLeaksInText(
	haystack: string,
	secrets: string[],
): void {
	for (const secret of secrets) {
		assert.notInclude(haystack, secret);
	}
}

export function assertNoSecretLeaksInCapturedCalls(
	calls: CapturedOpenAIPromptCall[],
	secrets: string[],
): void {
	for (const call of calls) {
		assertNoSecretLeaksInText(call.promptText, secrets);
		assertNoSecretLeaksInText(call.serializedBody, secrets);
	}
}
