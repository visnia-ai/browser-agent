import type {
	ChecklistDraft,
	ChecklistItem,
	ChecklistUpdate,
} from "../agents/types.js";

export const MAX_CHECKLIST_ITEMS = 12;

function cleanRequirement(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

export function normalizeChecklistDraft(value: unknown): ChecklistDraft | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const rawItems = (value as { items?: unknown }).items;
	if (!Array.isArray(rawItems)) return null;
	const items: string[] = [];
	const seen = new Set<string>();
	for (const raw of rawItems) {
		if (typeof raw !== "string") return null;
		const requirement = cleanRequirement(raw);
		if (!requirement) return null;
		const key = requirement.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		items.push(requirement);
		if (items.length >= MAX_CHECKLIST_ITEMS) break;
	}
	return items.length > 0 ? { items } : null;
}

export function createChecklistItems(requirements: string[]): ChecklistItem[] {
	return requirements.map((requirement, index) => ({
		id: `C${index + 1}`,
		requirement: cleanRequirement(requirement),
		status: "TODO",
	}));
}

export function cloneChecklist(items: ChecklistItem[]): ChecklistItem[] {
	return items.map((item) => ({ ...item }));
}

export function formatChecklistForPrompt(items: ChecklistItem[]): string[] {
	return items.map(
		(item) => `[${item.status}] ${item.id} ${item.requirement}`,
	);
}

export function normalizeChecklistUpdate(
	value: unknown,
	items: ChecklistItem[],
): ChecklistUpdate | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const validIds = new Set(items.map((item) => item.id));
	const result: ChecklistUpdate = {};
	for (const [rawId, rawStatus] of Object.entries(value)) {
		const id = rawId.trim().toUpperCase();
		if (!validIds.has(id) || typeof rawStatus !== "string") continue;
		const status = rawStatus.trim().toLowerCase();
		if (status === "done" || status === "regressed") {
			result[id] = status;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function applyChecklistUpdate(
	items: ChecklistItem[],
	update: ChecklistUpdate | undefined,
): void {
	if (!update) return;
	const byId = new Map(items.map((item) => [item.id, item]));
	for (const [id, status] of Object.entries(update)) {
		const item = byId.get(id);
		if (item) item.status = status === "done" ? "DONE" : "REGRESSED";
	}
}

export function applyVerifierChecklistChanges(params: {
	items: ChecklistItem[];
	reopenIds?: string[];
	addRequirements?: string[];
}): { reopenedIds: string[]; addedIds: string[] } {
	const byId = new Map(params.items.map((item) => [item.id, item]));
	const reopenedIds: string[] = [];
	for (const rawId of params.reopenIds ?? []) {
		if (typeof rawId !== "string") continue;
		const id = rawId.trim().toUpperCase();
		const item = byId.get(id);
		if (!item) continue;
		item.status = "TODO";
		if (!reopenedIds.includes(id)) reopenedIds.push(id);
	}

	const existing = new Set(
		params.items.map((item) => item.requirement.toLowerCase()),
	);
	const addedIds: string[] = [];
	for (const rawRequirement of params.addRequirements ?? []) {
		if (typeof rawRequirement !== "string") continue;
		if (params.items.length >= MAX_CHECKLIST_ITEMS) break;
		const requirement = cleanRequirement(rawRequirement);
		if (!requirement || existing.has(requirement.toLowerCase())) continue;
		const id = `C${params.items.length + 1}`;
		params.items.push({ id, requirement, status: "TODO" });
		existing.add(requirement.toLowerCase());
		addedIds.push(id);
	}
	return { reopenedIds, addedIds };
}

export function replaceChecklistPreservingDone(
	existing: ChecklistItem[],
	requirements: string[],
): ChecklistItem[] {
	const preserved = existing
		.filter((item) => item.status === "DONE")
		.map((item) => ({ ...item }));
	const seen = new Set(
		preserved.map((item) => item.requirement.toLowerCase()),
	);
	let nextId = existing.reduce((max, item) => {
		const number = Number.parseInt(item.id.replace(/^C/i, ""), 10);
		return Number.isFinite(number) ? Math.max(max, number + 1) : max;
	}, 1);
	for (const rawRequirement of requirements) {
		if (preserved.length >= MAX_CHECKLIST_ITEMS) break;
		const requirement = cleanRequirement(rawRequirement);
		if (!requirement || seen.has(requirement.toLowerCase())) continue;
		preserved.push({
			id: `C${nextId++}`,
			requirement,
			status: "TODO",
		});
		seen.add(requirement.toLowerCase());
	}
	return preserved.length > 0 ? preserved : cloneChecklist(existing);
}
