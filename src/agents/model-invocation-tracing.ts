import { serializeMessagesForDisk } from "./executor-utils/step-execution.js";
import type { ChatYAMLTraceEvent, StageModelInvocationTrace } from "./types.js";

export interface StageModelInvocationTraceOptions {
	stage: string;
	trace: ChatYAMLTraceEvent;
	meta?: Record<string, unknown>;
}

export function buildStageModelInvocationTrace(
	options: StageModelInvocationTraceOptions,
): StageModelInvocationTrace {
	return {
		step_kind: "stage_llm",
		stage: options.stage,
		attempt: options.trace.attempt,
		caller: options.trace.caller,
		provider: options.trace.provider,
		model: options.trace.model,
		messages: serializeMessagesForDisk(options.trace.messages),
		output: options.trace.output,
		raw_response: options.trace.raw_response,
		usage: options.trace.usage,
		reasoning_tokens: options.trace.reasoning_tokens ?? "",
		error: options.trace.error,
		meta: options.meta,
	};
}
