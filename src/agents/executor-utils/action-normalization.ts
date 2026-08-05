import type { Action, ExecutorResultItem } from "../types.js";
import { isUserTakeoverCategory } from "../../user-action-types.js";
import { configFeatureFlags } from "../../config-feature-flags.js";

export type NormalizeActionListResult =
	| {
			status: "accepted";
			actions: Action[];
			diagnostics: [];
	  }
	| {
			status: "rejected";
			diagnostics: string[];
	  };

export class ActionListContractError extends Error {
	readonly diagnostics: string[];

	constructor(diagnostics: string[]) {
		super(`Action list rejected: ${diagnostics.join("; ")}`);
		this.name = "ActionListContractError";
		this.diagnostics = [...diagnostics];
	}
}

const ACTION_TYPES = new Set<Action["type"]>([
	"click",
	"long_press",
	"type",
	"scroll",
	"evaluate",
	"dropdown_select",
	"navigate",
	"switch_tab",
	"wait",
	"download_current_file",
	"upload_files",
	"paste_file",
	"user_takeover",
	"memory_write",
	"memory_read",
	"read_file",
	"return_results",
	"memory_clear",
	"extract_data",
]);

function toInteger(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return Math.trunc(parsed);
	}
	return null;
}

function toDropdownValueString(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	return null;
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function toStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string");
	}
	if (typeof value === "string" && value.trim()) {
		return [value];
	}
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function normalizeDownloadCurrentFileAction(value?: unknown): {
	type: "download_current_file";
} {
	void value;
	return { type: "download_current_file" };
}

function normalizeAgentTakeoverRecord(
	obj: Record<string, unknown>,
): Action | null {
	const request = toTrimmedString(obj.request);
	if (!request) return null;
	return {
		type: "agent_takeover",
		request,
	};
}

function normalizeUserTakeoverRecord(
	obj: Record<string, unknown>,
): Action | null {
	const request = toTrimmedString(obj.request);
	if (!request) return null;
	const category = obj.category;
	return {
		type: "user_takeover",
		reason: request,
		...(isUserTakeoverCategory(category) ? { category } : {}),
	};
}

function normalizePasteFileRecord(obj: Record<string, unknown>): Action | null {
	const ref =
		typeof obj.ref === "string" && obj.ref.trim() ? obj.ref.trim() : null;
	const filePath =
		typeof obj.path === "string" && obj.path.trim() ? obj.path.trim() : null;
	if (!ref || !filePath) return null;
	return {
		type: "paste_file",
		ref,
		path: filePath,
	};
}

function normalizeLongPressRecord(obj: Record<string, unknown>): Action | null {
	const ref = toTrimmedString(obj.ref);
	if (!ref) return null;
	const durationValue = obj.durationMs ?? obj.duration_ms;
	if (durationValue !== undefined) {
		const durationMs = toInteger(durationValue);
		if (durationMs === null || durationMs < 100 || durationMs > 15_000) {
			return null;
		}
		return { type: "long_press", ref, durationMs };
	}
	return { type: "long_press", ref };
}

function normalizeReadFileRecord(obj: Record<string, unknown>): Action | null {
	const filePath = toTrimmedString(obj.path);
	return filePath ? { type: "read_file", path: filePath } : null;
}

function normalizeTypeRecord(obj: Record<string, unknown>): Action | null {
	const ref = toTrimmedString(obj.ref);
	if (!ref) return null;
	return {
		type: "type",
		ref,
		text: typeof obj.text === "string" ? obj.text : String(obj.text ?? ""),
		...(typeof obj.enter === "boolean" ? { enter: obj.enter } : {}),
	};
}

function normalizeExtractDataRecord(
	obj: Record<string, unknown>,
): Action | null {
	if (
		[
			"items",
			"ref",
			"hierarchy",
			"write_to",
			"writeTo",
			"start",
			"end_exclusive",
			"endExclusive",
		].some((key) => Object.prototype.hasOwnProperty.call(obj, key))
	) {
		return null;
	}
	if (obj.root === undefined && configFeatureFlags.extractDataWholeContext) {
		return { type: "extract_data" };
	}
	if (typeof obj.root !== "string") return null;
	return normalizeExtractDataRoot(obj.root);
}

function normalizeExtractDataRoot(root: string): Action | null {
	const roots = root.split(",").map((candidate) => candidate.trim());
	if (roots.length === 0 || roots.some((root) => !root)) return null;
	return { type: "extract_data", root: roots.join(",") };
}

function normalizeMemoryClearRecord(
	obj: Record<string, unknown>,
): Action | null {
	const rawTarget = obj.target ?? obj.memory_clear;
	if (
		rawTarget === "memory" ||
		rawTarget === "memory_result" ||
		rawTarget === "all"
	) {
		return { type: "memory_clear", target: rawTarget };
	}
	return null;
}

function normalizeReturnResultItems(
	value: unknown,
): ExecutorResultItem[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const results: ExecutorResultItem[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) return null;
		const link = toTrimmedString(entry.link);
		const summary = toTrimmedString(entry.summary);
		if (!link || !summary) return null;
		const downloadedFilePath = entry.downloaded_file_path;
		if (
			downloadedFilePath !== undefined &&
			!toTrimmedString(downloadedFilePath)
		) {
			return null;
		}
		results.push({
			link,
			summary,
			...(typeof downloadedFilePath === "string"
				? { downloaded_file_path: downloadedFilePath.trim() }
				: {}),
		});
	}
	return results;
}

function normalizeReturnResultsAction(value: unknown): Action | null {
	if (value === undefined || value === null || value === true) {
		return { type: "return_results" };
	}
	const results = normalizeReturnResultItems(value);
	return results ? { type: "return_results", results } : null;
}

export function normalizeShorthandActionEntry(entry: unknown): Action | null {
	if (typeof entry === "string") {
		const keyword = entry.trim();
		if (keyword === "memory_read") return { type: "memory_read" };
		if (keyword === "return_results") {
			return { type: "return_results" };
		}
		if (keyword === "download_current_file") {
			return { type: "download_current_file" };
		}
		if (
			keyword === "extract_data" &&
			configFeatureFlags.extractDataWholeContext
		) {
			return { type: "extract_data" };
		}
		return null;
	}
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return null;
	}
	const obj = entry as Record<string, unknown>;

	if (obj.type === "website_tool") {
		return null;
	}
	if (obj.type === "agent_takeover") {
		return normalizeAgentTakeoverRecord(obj);
	}
	if (obj.type === "user_takeover") {
		return normalizeUserTakeoverRecord(obj);
	}
	if (obj.type === "return_results") {
		return normalizeReturnResultsAction(obj.results);
	}

	// Every target-bearing action is validated here so obsolete target fields
	// cannot reach execution as invalid ref actions.
	if (
		typeof obj.type === "string" &&
		ACTION_TYPES.has(obj.type as Action["type"])
	) {
		if (obj.type === "click") {
			const ref = toTrimmedString(obj.ref);
			return ref ? { type: "click", ref } : null;
		}
		if (obj.type === "scroll") {
			if (typeof obj.ref !== "string" || !obj.ref.trim()) return null;
			const deltaX = toFiniteNumber(obj.deltaX);
			const deltaY = toFiniteNumber(obj.deltaY);
			if (deltaX === null && deltaY === null) return null;
			return {
				type: "scroll",
				ref: obj.ref.trim(),
				...(deltaX !== null ? { deltaX } : {}),
				...(deltaY !== null ? { deltaY } : {}),
			};
		}
		if (obj.type === "long_press") {
			return normalizeLongPressRecord(obj);
		}
		if (obj.type === "upload_files") {
			const ref =
				typeof obj.ref === "string" && obj.ref.trim() ? obj.ref.trim() : null;
			const paths = toStringArray(obj.paths);
			if (!ref || paths.length === 0) return null;
			return {
				type: "upload_files",
				ref,
				paths,
			};
		}
		if (obj.type === "paste_file") {
			return normalizePasteFileRecord(obj);
		}
		if (obj.type === "read_file") {
			return normalizeReadFileRecord(obj);
		}
		if (obj.type === "type") {
			if (typeof obj.ref !== "string" || !obj.ref.trim()) return null;
			return {
				type: "type",
				ref: obj.ref.trim(),
				text: typeof obj.text === "string" ? obj.text : String(obj.text ?? ""),
				...(typeof obj.enter === "boolean" ? { enter: obj.enter } : {}),
			};
		}
		if (obj.type === "wait") {
			const ms =
				toInteger(obj.ms) ??
				toInteger((obj as Record<string, unknown>).wait) ??
				toInteger((obj as Record<string, unknown>).value);
			if (ms === null) return null;
			return { type: "wait", ms };
		}
		if (obj.type === "download_current_file") {
			return normalizeDownloadCurrentFileAction(obj);
		}
		if (obj.type === "extract_data") {
			return normalizeExtractDataRecord(obj);
		}
		if (obj.type === "memory_clear") {
			return normalizeMemoryClearRecord(obj);
		}
		if (obj.type === "evaluate") {
			const script = toTrimmedString(obj.script);
			return script ? { type: "evaluate", script } : null;
		}
		if (obj.type === "dropdown_select") {
			const ref = toTrimmedString(obj.ref);
			const value = toDropdownValueString(obj.value);
			return ref && value !== null
				? { type: "dropdown_select", ref, value }
				: null;
		}
		if (obj.type === "navigate") {
			const url = toTrimmedString(obj.url);
			return url ? { type: "navigate", url } : null;
		}
		if (obj.type === "switch_tab") {
			const index = toInteger(obj.index);
			return index !== null ? { type: "switch_tab", index } : null;
		}
		if (obj.type === "memory_write") {
			return typeof obj.content === "string"
				? { type: "memory_write", content: obj.content }
				: null;
		}
		if (obj.type === "memory_read") return { type: "memory_read" };
		return null;
	}

	if (typeof obj.click === "string" && obj.click.trim()) {
		return { type: "click", ref: obj.click.trim() };
	}
	if (isRecord(obj.long_press)) {
		return normalizeLongPressRecord(obj.long_press);
	}
	if (isRecord(obj.type)) {
		return normalizeTypeRecord(obj.type);
	}
	if (
		Object.prototype.hasOwnProperty.call(obj, "scroll") &&
		obj.scroll &&
		typeof obj.scroll === "object" &&
		!Array.isArray(obj.scroll)
	) {
		const scroll = obj.scroll as Record<string, unknown>;
		const ref = scroll.ref;
		const deltaX = toFiniteNumber(scroll.deltaX);
		const deltaY = toFiniteNumber(scroll.deltaY);
		if (typeof ref === "string" && ref.trim()) {
			if (deltaX === null && deltaY === null) return null;
			return {
				type: "scroll",
				ref: ref.trim(),
				...(deltaX !== null ? { deltaX } : {}),
				...(deltaY !== null ? { deltaY } : {}),
			};
		}
		return null;
	}
	if (Object.prototype.hasOwnProperty.call(obj, "evaluate")) {
		let script: unknown = obj.script;
		if (
			obj.evaluate &&
			typeof obj.evaluate === "object" &&
			!Array.isArray(obj.evaluate)
		) {
			script = (obj.evaluate as Record<string, unknown>).script ?? script;
		} else if (typeof obj.evaluate === "string" && obj.evaluate.trim()) {
			script = obj.evaluate;
		}
		if (typeof script === "string") {
			return { type: "evaluate", script };
		}
		return null;
	}
	if (
		Object.prototype.hasOwnProperty.call(obj, "dropdown_select") &&
		obj.dropdown_select &&
		typeof obj.dropdown_select === "object" &&
		!Array.isArray(obj.dropdown_select)
	) {
		const ds = obj.dropdown_select as Record<string, unknown>;
		const ref = ds.ref;
		const value = toDropdownValueString(ds.value);
		if (typeof ref === "string" && ref.trim() && value !== null) {
			return { type: "dropdown_select", ref: ref.trim(), value };
		}
		return null;
	}
	if (typeof obj.navigate === "string") {
		return { type: "navigate", url: obj.navigate };
	}
	if (Object.prototype.hasOwnProperty.call(obj, "switch_tab")) {
		const index = toInteger(obj.switch_tab);
		if (index !== null) return { type: "switch_tab", index };
		return null;
	}
	if (Object.prototype.hasOwnProperty.call(obj, "wait")) {
		const ms = toInteger(obj.wait);
		if (ms !== null) return { type: "wait", ms };
		return null;
	}
	if (Object.prototype.hasOwnProperty.call(obj, "download_current_file")) {
		return normalizeDownloadCurrentFileAction(obj.download_current_file);
	}
	if (
		Object.prototype.hasOwnProperty.call(obj, "upload_files") &&
		obj.upload_files &&
		typeof obj.upload_files === "object" &&
		!Array.isArray(obj.upload_files)
	) {
		const upload = obj.upload_files as Record<string, unknown>;
		const ref =
			typeof upload.ref === "string" && upload.ref.trim()
				? upload.ref.trim()
				: null;
		const paths = toStringArray(upload.paths);
		if (!ref || paths.length === 0) return null;
		return {
			type: "upload_files",
			ref,
			paths,
		};
	}
	if (
		Object.prototype.hasOwnProperty.call(obj, "paste_file") &&
		obj.paste_file &&
		typeof obj.paste_file === "object" &&
		!Array.isArray(obj.paste_file)
	) {
		return normalizePasteFileRecord(obj.paste_file as Record<string, unknown>);
	}
	if (typeof obj.memory_write === "string") {
		return { type: "memory_write", content: obj.memory_write };
	}
	if (Object.prototype.hasOwnProperty.call(obj, "memory_read")) {
		return { type: "memory_read" };
	}
	if (isRecord(obj.read_file)) {
		return normalizeReadFileRecord(obj.read_file);
	}
	if (Object.prototype.hasOwnProperty.call(obj, "return_results")) {
		return normalizeReturnResultsAction(obj.return_results);
	}
	if (Object.prototype.hasOwnProperty.call(obj, "memory_clear")) {
		if (typeof obj.memory_clear === "string") {
			return normalizeMemoryClearRecord(obj);
		}
		if (isRecord(obj.memory_clear)) {
			return normalizeMemoryClearRecord(obj.memory_clear);
		}
	}
	if (Object.prototype.hasOwnProperty.call(obj, "extract_data")) {
		if (
			configFeatureFlags.extractDataWholeContext &&
			(obj.extract_data === null || obj.extract_data === "")
		) {
			return { type: "extract_data" };
		}
		if (typeof obj.extract_data === "string") {
			return normalizeExtractDataRoot(obj.extract_data);
		}
	}
	if (typeof obj.agent_takeover === "string" && obj.agent_takeover.trim()) {
		return {
			type: "agent_takeover",
			request: obj.agent_takeover.trim(),
		};
	}
	if (isRecord(obj.agent_takeover)) {
		return normalizeAgentTakeoverRecord(obj.agent_takeover);
	}
	if (
		Object.prototype.hasOwnProperty.call(obj, "user_takeover") &&
		obj.user_takeover &&
		typeof obj.user_takeover === "object" &&
		!Array.isArray(obj.user_takeover)
	) {
		const takeover = obj.user_takeover as Record<string, unknown>;
		return normalizeUserTakeoverRecord(takeover);
	}
	if (typeof obj.user_takeover === "string") {
		return { type: "user_takeover", reason: obj.user_takeover };
	}
	return null;
}

function actionEntries(actions: unknown): {
	entries: unknown[];
	diagnostics: string[];
} {
	if (Array.isArray(actions)) {
		return { entries: actions, diagnostics: [] };
	}
	if (
		typeof actions === "string" ||
		(actions && typeof actions === "object" && !Array.isArray(actions))
	) {
		return { entries: [actions], diagnostics: [] };
	}
	if (actions === null || actions === undefined) {
		return { entries: [], diagnostics: [] };
	}
	return {
		entries: [],
		diagnostics: [
			`actions: expected an array of action entries, got ${typeof actions}`,
		],
	};
}

function describeMalformedAction(index: number, entry: unknown): string {
	const prefix = `actions[${index}]`;
	if (typeof entry === "string") {
		return `${prefix}: unrecognized action string "${entry}"`;
	}
	if (!isRecord(entry)) {
		return `${prefix}: expected an action object or recognized action string`;
	}
	if (entry.type === "agent_takeover") {
		return `${prefix}: agent_takeover requires a non-empty "request" string`;
	}
	if (entry.type === "user_takeover") {
		return `${prefix}: user_takeover requires a non-empty "request" string`;
	}
	if (
		entry.type === "long_press" ||
		Object.prototype.hasOwnProperty.call(entry, "long_press")
	) {
		return `${prefix}: long_press requires a non-empty ref and optional durationMs from 100 to 15000`;
	}
	if (
		entry.type === "read_file" ||
		Object.prototype.hasOwnProperty.call(entry, "read_file")
	) {
		return `${prefix}: read_file requires a non-empty workspace-relative path`;
	}
	if (
		entry.type === "return_results" ||
		Object.prototype.hasOwnProperty.call(entry, "return_results")
	) {
		return `${prefix}: return_results must be empty or a non-empty list of {link, summary, downloaded_file_path?} objects`;
	}
	if (
		entry.type === "extract_data" ||
		Object.prototype.hasOwnProperty.call(entry, "extract_data")
	) {
		return configFeatureFlags.extractDataWholeContext
			? `${prefix}: whole-context extract_data must be the bare list scalar "- extract_data"`
			: `${prefix}: extract_data requires a non-empty root string`;
	}
	if (isRecord(entry.agent_takeover)) {
		return `${prefix}: agent_takeover requires a non-empty "request" string`;
	}
	if (isRecord(entry.user_takeover)) {
		return `${prefix}: user_takeover requires a non-empty "request" string`;
	}
	if (isRecord(entry.type)) {
		return `${prefix}: type requires {ref, text, enter?} with a non-empty ref`;
	}
	if (typeof entry.type === "string") {
		return `${prefix}: malformed or unsupported action type "${entry.type}"`;
	}
	return `${prefix}: malformed or unsupported action entry`;
}

export function normalizeActionListWithDiagnostics(
	actions: unknown,
): NormalizeActionListResult {
	const { entries, diagnostics } = actionEntries(actions);
	const normalized: Action[] = [];
	for (const [index, entry] of entries.entries()) {
		const parsed = normalizeShorthandActionEntry(entry);
		if (parsed) {
			normalized.push(parsed);
		} else {
			diagnostics.push(describeMalformedAction(index, entry));
		}
	}
	if (diagnostics.length > 0) {
		return { status: "rejected", diagnostics };
	}
	return { status: "accepted", actions: normalized, diagnostics: [] };
}

export function normalizeActionList(actions: unknown): Action[] {
	const result = normalizeActionListWithDiagnostics(actions);
	if (result.status === "rejected") {
		throw new ActionListContractError(result.diagnostics);
	}
	return result.actions;
}
