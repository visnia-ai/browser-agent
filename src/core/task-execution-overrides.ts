import * as fs from "fs";

export interface TaskExecutionOverride {
	task: string;
	url?: string;
	metadata?: Record<string, unknown>;
}

export interface TaskExecutionOverridesFile {
	tasks: TaskExecutionOverride[];
}

export interface TaskExecutionOverridesIndex {
	file: TaskExecutionOverridesFile;
	tasksByExactText: Map<string, TaskExecutionOverride>;
}

export function loadTaskExecutionOverrides(
	overridesPath: string,
): TaskExecutionOverridesIndex {
	const raw = JSON.parse(fs.readFileSync(overridesPath, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid task execution overrides file: ${overridesPath}`);
	}
	const file = raw as TaskExecutionOverridesFile;
	if (!Array.isArray(file.tasks)) {
		throw new Error(
			`Invalid task execution overrides file ${overridesPath}: missing tasks array.`,
		);
	}

	const tasksByExactText = new Map<string, TaskExecutionOverride>();
	for (const override of file.tasks) {
		if (
			!override ||
			typeof override !== "object" ||
			typeof override.task !== "string"
		) {
			continue;
		}
		if ("initialPlanOverride" in override) {
			throw new Error(
				`Invalid task execution override for ${JSON.stringify(override.task)}: initialPlanOverride has been removed.`,
			);
		}
		const normalized = normalizeTaskText(override.task);
		if (!normalized) {
			continue;
		}
		tasksByExactText.set(normalized, normalizeTaskExecutionOverride(override));
	}
	return {
		file,
		tasksByExactText,
	};
}

export function findTaskExecutionOverride(
	index: TaskExecutionOverridesIndex | undefined,
	task: string,
): TaskExecutionOverride | undefined {
	return index?.tasksByExactText.get(normalizeTaskText(task));
}

function normalizeTaskExecutionOverride(
	override: TaskExecutionOverride,
): TaskExecutionOverride {
	const url =
		typeof override.url === "string" && override.url.trim()
			? override.url.trim()
			: undefined;
	return {
		task: override.task,
		...(url ? { url } : {}),
		...(override.metadata &&
		typeof override.metadata === "object" &&
		!Array.isArray(override.metadata)
			? { metadata: override.metadata }
			: {}),
	};
}

function normalizeTaskText(task: string): string {
	return task.trim().replace(/\s+/g, " ");
}
