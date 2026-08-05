import { chatYAML, userMessage } from "./providers/router.js";
import { buildStageModelInvocationTrace } from "./model-invocation-tracing.js";
import type {
	ChecklistDraft,
	LLMOptions,
	Message,
	StageModelInvocationTrace,
} from "./types.js";

const CHECKLIST_SYSTEM = `You decompose a browser task into a concise semantic completion checklist.

The checklist describes WHAT the final browser state or returned result must satisfy, not HOW to navigate the site.

Rules:
- The original task is authoritative. Do not add requirements from external knowledge.
- Preserve every requested entity, field, count, range, date, unit, filter, ordering, negation, and output-format constraint.
- Preserve words such as all, each, exactly, at least, only, before, and after.
- Do not include procedural steps such as opening a page, clicking, scrolling, or searching.
- Combine closely related constraints into one concise sentence when doing so does not hide a deliverable.
- Return at most 12 checklist items. Each item must be one non-empty sentence.

Respond with raw YAML only:
items:
  - "Concise completion requirement."
  - "Another completion requirement."`;

export interface CreateChecklistTraceOptions {
	onTrace?: (trace: StageModelInvocationTrace) => void;
	meta?: Record<string, unknown>;
}

export interface CreateChecklistRuntimeContext {
	existingChecklist?: Array<{
		id: string;
		requirement: string;
		status: string;
	}>;
	verifierSummary?: string;
}

export async function createChecklist(
	task: string,
	options: LLMOptions,
	traceOptions?: CreateChecklistTraceOptions,
	runtimeContext?: CreateChecklistRuntimeContext,
): Promise<ChecklistDraft> {
	const messages: Message[] = [
		{ role: "system", content: CHECKLIST_SYSTEM },
		userMessage(
			[
				`Task: ${task}`,
				runtimeContext?.existingChecklist?.length
					? `Existing checklist to revise:\n${runtimeContext.existingChecklist
							.map(
								(item) =>
									`- [${item.status}] ${item.id} ${item.requirement}`,
							)
							.join("\n")}`
					: "",
				runtimeContext?.verifierSummary
					? `Verifier correction: ${runtimeContext.verifierSummary}`
					: "",
			]
				.filter(Boolean)
				.join("\n\n"),
		),
	];

	const { data } = await chatYAML<ChecklistDraft>(
		messages,
		options,
		"createChecklist",
		(trace) =>
			traceOptions?.onTrace?.(
				buildStageModelInvocationTrace({
					stage: "createChecklist",
					trace,
					meta: traceOptions.meta,
				}),
			),
	);
	return data;
}
