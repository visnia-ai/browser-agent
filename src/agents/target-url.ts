import { buildStageModelInvocationTrace } from "./model-invocation-tracing.js";
import { URL_SYSTEM } from "./prompts.js";
import { chatYAML } from "./providers/router.js";
import type {
	LLMOptions,
	Message,
	StageModelInvocationTrace,
	TargetURL,
} from "./types.js";

interface StageTraceOptions {
	onTrace?: (trace: StageModelInvocationTrace) => void;
	meta?: Record<string, unknown>;
}

export async function findTargetURL(
	task: string,
	options: LLMOptions,
	traceOptions?: StageTraceOptions,
): Promise<string> {
	const messages: Message[] = [
		{ role: "system", content: URL_SYSTEM },
		{ role: "user", content: `Task: ${task}` },
	];

	const { data } = await chatYAML<TargetURL>(
		messages,
		options,
		"findTargetURL",
		(trace) =>
			traceOptions?.onTrace?.(
				buildStageModelInvocationTrace({
					stage: "findTargetURL",
					trace,
					meta: traceOptions.meta,
				}),
			),
	);
	return data.url;
}
