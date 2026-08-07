import type { Protocol } from "devtools-protocol";
import type { Browser } from "./types.js";
import {
	replaceSemanticRefSnapshot,
	type SemanticRefTarget,
} from "./semantic-ref-registry.js";

export interface SemanticProjectionOptions {
	omitHrefs?: boolean;
	preserveFullHrefs?: boolean;
	redactInputRefs?: string[];
	redactPasswordInputs?: boolean;
	stepNumber?: number;
}

interface ProjectionNode {
	id: string;
	backendNodeId?: number;
	role: string;
	name: string;
	value: string;
	description: string;
	properties: Map<string, unknown>;
	childIds: string[];
	ignored: boolean;
}

const INTERACTIVE_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"gridcell",
	"link",
	"listbox",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"radio",
	"scrollbar",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textbox",
	"treeitem",
]);

const STRUCTURAL_ROLES = new Set([
	"alert",
	"article",
	"banner",
	"cell",
	"columnheader",
	"complementary",
	"contentinfo",
	"dialog",
	"document",
	"feed",
	"figure",
	"form",
	"grid",
	"group",
	"heading",
	"list",
	"listitem",
	"main",
	"menu",
	"menubar",
	"navigation",
	"region",
	"row",
	"rowgroup",
	"rowheader",
	"search",
	"table",
	"tablist",
	"toolbar",
	"tree",
	"treegrid",
]);

const TEXT_ROLES = new Set([
	"caption",
	"code",
	"definition",
	"emphasis",
	"labeltext",
	"legend",
	"mark",
	"paragraph",
	"statictext",
	"strong",
	"term",
	"time",
]);

const OMITTED_ROLES = new Set(["inlinetextbox"]);

const LARGE_PLAIN_TEXT_MIN_CHARACTERS = 250_000;
const LARGE_PLAIN_TEXT_PREVIEW_CHARACTERS = 600;

const CANONICAL_CONTEXT_ROLES = new Set([
	"alert",
	"cell",
	"columnheader",
	"dialog",
	"document",
	"form",
	"grid",
	"heading",
	"list",
	"listbox",
	"main",
	"navigation",
	"region",
	"row",
	"rowheader",
	"search",
	"table",
	"tablist",
	"toolbar",
	"tree",
	"treegrid",
]);

const CANONICAL_CONTAINER_REF_ROLES = new Set([
	"dialog",
	"document",
	"form",
	"grid",
	"list",
	"listbox",
	"main",
	"region",
	"table",
	"tree",
	"treegrid",
]);

const CANONICAL_TEXT_CONTAINER_ROLES = new Set([
	"definition",
	"emphasis",
	"labeltext",
	"legend",
	"listitem",
	"mark",
	"paragraph",
	"strong",
	"term",
	"time",
]);

const CANONICAL_TEXT_LEAF_ROLES = new Set(["caption", "code", "statictext"]);

interface SemanticProjectionNode {
	role: string;
	fields: Map<string, string>;
	children: SemanticProjectionNode[];
}

interface CanonicalProjectionLine {
	line: string;
	children: CanonicalProjectionLine[];
	text?: string;
}

const STATE_PROPERTIES = [
	"autocomplete",
	"checked",
	"disabled",
	"expanded",
	"haspopup",
	"invalid",
	"level",
	"multiselectable",
	"orientation",
	"pressed",
	"readonly",
	"required",
	"selected",
	"valuemax",
	"valuemin",
	"valuetext",
] as const;

const CANONICAL_STATE_PROPERTIES = new Set<string>(STATE_PROPERTIES);

function axValue(value: Protocol.Accessibility.AXValue | undefined): unknown {
	return value?.value;
}

function normalizedText(value: unknown, maxLength = 600): string {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizedRole(value: unknown): string {
	const role = normalizedText(value, 80).toLowerCase();
	return role === "rootwebarea" || role === "webarea" ? "document" : role;
}

function projectionRef(backendNodeId: number): string {
	return `r${backendNodeId.toString(36)}`;
}

function escapeValue(value: string): string {
	return JSON.stringify(value);
}

interface LargePlainTextDocument {
	characterCount: number;
	preview: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function inspectLargePlainTextDocument(
	browser: Browser,
): Promise<LargePlainTextDocument | undefined> {
	if (typeof browser.Runtime?.evaluate !== "function") return undefined;
	try {
		const { result } = await browser.Runtime.evaluate({
			expression: `(() => {
				const contentType = String(document.contentType || "")
					.split(";", 1)[0]
					.trim()
					.toLowerCase();
				if (contentType !== "text/plain") return { contentType };
				const body = document.body;
				const soleBodyElement = body?.childElementCount === 1
					? body.firstElementChild
					: null;
				const nativePlainTextShape =
					soleBodyElement?.tagName === "PRE" &&
					document.scripts.length === 0;
				if (!nativePlainTextShape) {
					return { contentType, nativePlainTextShape: false };
				}
				const text = soleBodyElement.textContent || "";
				return {
					contentType,
					nativePlainTextShape: true,
					characterCount: text.length,
					preview: text.slice(0, ${LARGE_PLAIN_TEXT_PREVIEW_CHARACTERS}),
				};
			})()`,
			returnByValue: true,
		});
		const value = result.value;
		if (
			!isRecord(value) ||
			value.contentType !== "text/plain" ||
			value.nativePlainTextShape !== true ||
			typeof value.characterCount !== "number" ||
			!Number.isFinite(value.characterCount) ||
			value.characterCount < LARGE_PLAIN_TEXT_MIN_CHARACTERS
		) {
			return undefined;
		}
		return {
			characterCount: Math.trunc(value.characterCount),
			preview: typeof value.preview === "string" ? value.preview : "",
		};
	} catch {
		// Missing or ambiguous MIME/DOM metadata must retain normal AX extraction.
		return undefined;
	}
}

function serializeLargePlainTextProjection(
	document: LargePlainTextDocument,
): string {
	const preview = normalizedText(
		document.preview,
		LARGE_PLAIN_TEXT_PREVIEW_CHARACTERS,
	);
	return [
		"projection semantic-v1 refs=0",
		`document name="Large plain-text resource" value="${document.characterCount} characters"`,
		...(preview ? [`  text name=${escapeValue(preview)}`] : []),
		'  text name="[remaining plain text omitted from semantic projection]"',
	].join("\n");
}

function decodeProjectionField(rawValue: string | undefined): string {
	if (!rawValue) return "";
	if (!rawValue.startsWith('"')) return rawValue;
	try {
		const parsed = JSON.parse(rawValue);
		return typeof parsed === "string" ? parsed : rawValue;
	} catch {
		return rawValue;
	}
}

function cleanProjectionText(value: string): string {
	return normalizedText(
		value
			.replace(/[\uE000-\uF8FF]/g, " ")
			.replace(/[\u200B-\u200D\uFEFF]/g, " "),
		1_200,
	);
}

function projectionNodeName(node: SemanticProjectionNode): string {
	return cleanProjectionText(decodeProjectionField(node.fields.get("name")));
}

function isActionableNode(node: SemanticProjectionNode): boolean {
	if (INTERACTIVE_ROLES.has(node.role)) return true;
	if (node.fields.get("focusable") === "true") return true;
	return (
		node.fields.has("ref") &&
		!STRUCTURAL_ROLES.has(node.role) &&
		!TEXT_ROLES.has(node.role)
	);
}

function shouldKeepRef(node: SemanticProjectionNode): boolean {
	return (
		isActionableNode(node) ||
		CANONICAL_CONTAINER_REF_ROLES.has(node.role) ||
		node.fields.get("focusable") === "true"
	);
}

function collectCanonicalText(node: SemanticProjectionNode): string[] {
	if (isActionableNode(node)) return [];
	const collected: string[] = [];
	if (
		CANONICAL_TEXT_CONTAINER_ROLES.has(node.role) ||
		CANONICAL_TEXT_LEAF_ROLES.has(node.role) ||
		(node.children.length === 0 && !CANONICAL_CONTEXT_ROLES.has(node.role))
	) {
		const name = projectionNodeName(node);
		if (name) collected.push(name);
	}
	for (const child of node.children) {
		collected.push(...collectCanonicalText(child));
	}
	return collected.filter((text, index, all) => text !== all[index - 1]);
}

function canonicalFieldValue(
	node: SemanticProjectionNode,
	field: string,
): string | undefined {
	const raw = node.fields.get(field);
	if (!raw) return undefined;
	if (raw === "false" || raw === '"false"' || raw === '"undefined"') {
		return undefined;
	}
	if (
		field === "name" ||
		field === "value" ||
		field === "description" ||
		field === "href"
	) {
		const cleaned = cleanProjectionText(decodeProjectionField(raw));
		return cleaned ? escapeValue(cleaned) : undefined;
	}
	return raw;
}

function formatCanonicalProjectionNode(
	node: SemanticProjectionNode,
	options: { optionNames?: string[] } = {},
): string {
	const fields: string[] = [];
	if (shouldKeepRef(node)) {
		const ref = node.fields.get("ref");
		if (ref) fields.push(`ref=${ref}`);
	}
	for (const field of ["name", "value", "description", "href"]) {
		const value = canonicalFieldValue(node, field);
		if (value) fields.push(`${field}=${value}`);
	}
	for (const field of CANONICAL_STATE_PROPERTIES) {
		const value = canonicalFieldValue(node, field);
		if (value) fields.push(`${field}=${value}`);
	}
	if (options.optionNames && options.optionNames.length > 0) {
		fields.push(`options=${JSON.stringify(options.optionNames)}`);
	}
	return fields.length > 0 ? `${node.role} ${fields.join(" ")}` : node.role;
}

function canonicalTextLine(text: string): CanonicalProjectionLine | null {
	const cleaned = cleanProjectionText(text);
	if (!cleaned) return null;
	return {
		line: `text name=${escapeValue(cleaned)}`,
		children: [],
		text: cleaned,
	};
}

function mergeAdjacentCanonicalText(
	lines: CanonicalProjectionLine[],
): CanonicalProjectionLine[] {
	const merged: CanonicalProjectionLine[] = [];
	for (const line of lines) {
		const previous = merged[merged.length - 1];
		if (previous?.text && line.text) {
			const text = cleanProjectionText(`${previous.text} ${line.text}`);
			previous.text = text;
			previous.line = `text name=${escapeValue(text)}`;
			continue;
		}
		merged.push(line);
	}
	return merged;
}

function canonicalInteractiveDescendants(
	node: SemanticProjectionNode,
	coveredText: string,
): CanonicalProjectionLine[] {
	const rendered: CanonicalProjectionLine[] = [];
	for (const child of node.children) {
		if (
			isActionableNode(child) ||
			CANONICAL_CONTEXT_ROLES.has(child.role)
		) {
			rendered.push(...canonicalizeProjectionNode(child, coveredText));
			continue;
		}
		rendered.push(...canonicalInteractiveDescendants(child, coveredText));
	}
	return rendered;
}

function canonicalizeProjectionNode(
	node: SemanticProjectionNode,
	coveredText = "",
): CanonicalProjectionLine[] {
	const name = projectionNodeName(node);
	if (CANONICAL_TEXT_LEAF_ROLES.has(node.role)) {
		if (name && coveredText.includes(name)) return [];
		const text = canonicalTextLine(name);
		return text ? [text] : [];
	}

	if (CANONICAL_TEXT_CONTAINER_ROLES.has(node.role)) {
		const text = cleanProjectionText(collectCanonicalText(node).join(" "));
		const rendered: CanonicalProjectionLine[] = [];
		if (text) {
			const line = canonicalTextLine(text);
			if (line) rendered.push(line);
		}
		rendered.push(...canonicalInteractiveDescendants(node, text));
		return mergeAdjacentCanonicalText(rendered);
	}

	if (isActionableNode(node)) {
		const directOptions =
			node.role === "combobox"
				? node.children.filter((child) => child.role === "option")
				: [];
		const optionNames = directOptions
			.map(projectionNodeName)
			.filter(Boolean);
		const children = node.children
			.filter((child) => !directOptions.includes(child))
			.flatMap((child) =>
				canonicalizeProjectionNode(child, name || coveredText),
			);
		return [
			{
				line: formatCanonicalProjectionNode(node, { optionNames }),
				children: mergeAdjacentCanonicalText(children),
			},
		];
	}

	if (CANONICAL_CONTEXT_ROLES.has(node.role)) {
		const suppressChildText = node.role === "heading" ? name : coveredText;
		const children = node.children.flatMap((child) =>
			canonicalizeProjectionNode(child, suppressChildText),
		);
		const line = formatCanonicalProjectionNode(node);
		if (
			line === node.role &&
			!shouldKeepRef(node) &&
			!name &&
			node.role !== "row" &&
			node.role !== "cell"
		) {
			return mergeAdjacentCanonicalText(children);
		}
		return [{ line, children: mergeAdjacentCanonicalText(children) }];
	}

	if (name || node.fields.has("value") || node.fields.has("description")) {
		return [
			{
				line: formatCanonicalProjectionNode(node),
				children: mergeAdjacentCanonicalText(
					node.children.flatMap((child) =>
						canonicalizeProjectionNode(child, name || coveredText),
					),
				),
			},
		];
	}

	return mergeAdjacentCanonicalText(
		node.children.flatMap((child) =>
			canonicalizeProjectionNode(child, coveredText),
		),
	);
}

function serializeCanonicalProjectionLines(
	lines: CanonicalProjectionLine[],
	depth = 0,
): string[] {
	return lines.flatMap((line) => [
		`${"  ".repeat(depth)}${line.line}`,
		...serializeCanonicalProjectionLines(line.children, depth + 1),
	]);
}

function serializeCanonicalSemanticProjection(
	roots: SemanticProjectionNode[],
): string {
	const body = serializeCanonicalProjectionLines(
		mergeAdjacentCanonicalText(
			roots.flatMap((node) => canonicalizeProjectionNode(node)),
		),
	);
	const exposedRefs = body.reduce(
		(count, line) => count + (line.match(/\bref=/g)?.length ?? 0),
		0,
	);
	return [`projection semantic-v1 refs=${exposedRefs}`, ...body].join("\n");
}

function getProperties(
	node: Protocol.Accessibility.AXNode,
): Map<string, unknown> {
	return new Map(
		(node.properties ?? []).map((property) => [
			property.name,
			axValue(property.value),
		]),
	);
}

function capabilitiesFor(node: ProjectionNode): string[] {
	const capabilities: string[] = [];
	if (
		INTERACTIVE_ROLES.has(node.role) ||
		node.properties.get("focusable") === true
	) {
		capabilities.push("click");
	}
	if (
		node.role === "textbox" ||
		node.role === "searchbox" ||
		node.role === "combobox" ||
		node.properties.get("editable") !== undefined
	) {
		capabilities.push("type");
	}
	if (
		node.role === "combobox" ||
		node.role === "listbox" ||
		node.role === "option"
	) {
		capabilities.push("select");
	}
	if (node.role === "slider" || node.role === "scrollbar") {
		capabilities.push("set_value");
	}
	capabilities.push("inspect", "extract");
	return [...new Set(capabilities)];
}

function shouldExposeContainer(node: ProjectionNode): boolean {
	return (
		STRUCTURAL_ROLES.has(node.role) ||
		INTERACTIVE_ROLES.has(node.role) ||
		node.properties.get("focusable") === true
	);
}

function shouldRenderNode(node: ProjectionNode): boolean {
	if (OMITTED_ROLES.has(node.role)) return false;
	return (
		shouldExposeContainer(node) ||
		TEXT_ROLES.has(node.role) ||
		Boolean(node.name || node.value || node.description)
	);
}

function buildProjectionFields(params: {
	node: ProjectionNode;
	ref?: string;
	redactInputRefs: Set<string>;
	redactPasswordInputs: boolean;
	omitHrefs: boolean;
	preserveFullHrefs: boolean;
}): Map<string, string> {
	const { node, ref } = params;
	const fields = new Map<string, string>();
	if (ref) fields.set("ref", escapeValue(ref));
	if (node.name) fields.set("name", escapeValue(node.name));
	if (
		ref &&
		!INTERACTIVE_ROLES.has(node.role) &&
		node.properties.get("focusable") === true
	) {
		fields.set("focusable", "true");
	}

	const protectedValue = node.properties.get("protected") === true;
	const shouldRedact =
		protectedValue ||
		(ref !== undefined && params.redactInputRefs.has(ref)) ||
		(params.redactPasswordInputs &&
			(node.role === "textbox" || node.role === "searchbox"));
	if (node.value) {
		fields.set(
			"value",
			escapeValue(shouldRedact ? "[REDACTED]" : node.value),
		);
	}
	if (node.description && node.description !== node.name) {
		fields.set("description", escapeValue(node.description));
	}
	for (const propertyName of STATE_PROPERTIES) {
		const value = node.properties.get(propertyName);
		if (value === undefined || value === false || value === "") continue;
		fields.set(
			propertyName,
			typeof value === "string"
				? escapeValue(normalizedText(value, 160))
				: String(value),
		);
	}
	if (!params.omitHrefs) {
		const url = normalizedText(
			node.properties.get("url"),
			params.preserveFullHrefs ? 8_000 : 500,
		);
		if (url) fields.set("href", escapeValue(url));
	}
	return fields;
}

export async function getSemanticProjection(
	browser: Browser,
	options: SemanticProjectionOptions = {},
): Promise<string> {
	const largePlainTextDocument =
		await inspectLargePlainTextDocument(browser);
	if (largePlainTextDocument) {
		replaceSemanticRefSnapshot(browser, []);
		return serializeLargePlainTextProjection(largePlainTextDocument);
	}
	const response = await browser.Accessibility.getFullAXTree();
	const nodes = new Map<string, ProjectionNode>();
	for (const rawNode of response.nodes) {
		const id = String(rawNode.nodeId);
		nodes.set(id, {
			id,
			backendNodeId: rawNode.backendDOMNodeId,
			role: normalizedRole(axValue(rawNode.role)),
			name: normalizedText(axValue(rawNode.name)),
			value: normalizedText(axValue(rawNode.value)),
			description: normalizedText(axValue(rawNode.description)),
			properties: getProperties(rawNode),
			childIds: (rawNode.childIds ?? []).map(String),
			ignored: rawNode.ignored === true,
		});
	}

	const childIds = new Set(
		[...nodes.values()].flatMap((node) => node.childIds),
	);
	const roots = [...nodes.values()].filter((node) => !childIds.has(node.id));
	const targets = new Map<string, SemanticRefTarget>();
	const redactInputRefs = new Set(
		(options.redactInputRefs ?? [])
			.map((ref) => ref.trim())
			.filter(Boolean),
	);
	const renderedNodeIds = new Set<string>();

	const render = (
		node: ProjectionNode,
		ancestors: Set<string>,
		ancestorName = "",
	): SemanticProjectionNode[] => {
		if (ancestors.has(node.id)) return [];
		const nextAncestors = new Set(ancestors).add(node.id);
		const duplicatesAncestorName =
			TEXT_ROLES.has(node.role) &&
			Boolean(ancestorName) &&
			node.name === ancestorName;
		if (node.ignored || !shouldRenderNode(node) || duplicatesAncestorName) {
			return node.childIds.flatMap((childId) => {
				const child = nodes.get(childId);
				return child ? render(child, nextAncestors, ancestorName) : [];
			});
		}

		renderedNodeIds.add(node.id);
		let ref: string | undefined;
		if (node.backendNodeId && shouldExposeContainer(node)) {
			ref = projectionRef(node.backendNodeId);
			targets.set(ref, {
				ref,
				backendNodeId: node.backendNodeId,
				role: node.role,
				capabilities: capabilitiesFor(node),
			});
		}
		const fields = buildProjectionFields({
			node,
			ref,
			redactInputRefs,
			redactPasswordInputs: options.redactPasswordInputs === true,
			omitHrefs: options.omitHrefs !== false,
			preserveFullHrefs: options.preserveFullHrefs === true,
		});
		const children = node.childIds.flatMap((childId) => {
			const child = nodes.get(childId);
			return child
				? render(child, nextAncestors, node.name || ancestorName)
				: [];
		});
		return [{ role: node.role || "node", fields, children }];
	};

	let semanticRoots = roots.flatMap((root) => render(root, new Set()));
	if (semanticRoots.length === 0) {
		semanticRoots = [...nodes.values()]
			.filter((node) => !renderedNodeIds.has(node.id))
			.flatMap((node) => render(node, new Set()));
	}
	const projection = serializeCanonicalSemanticProjection(semanticRoots);
	const exposedRefs = new Set(
		[...projection.matchAll(/\bref="([^"]+)"/g)].map((match) => match[1]),
	);
	replaceSemanticRefSnapshot(
		browser,
		[...targets.values()].filter((target) => exposedRefs.has(target.ref)),
	);
	return projection;
}
