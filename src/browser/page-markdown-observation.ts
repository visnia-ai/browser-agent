import { MarkItDown } from "markitdown-ts";
import type { Protocol } from "devtools-protocol";
import type { Browser } from "./types.js";
import { getSemanticProjection } from "./semantic-projection.js";
import {
	getSemanticRefTarget,
	getSemanticRefTargets,
	replaceSemanticRefSnapshot,
	resolveSemanticRef,
} from "./semantic-ref-registry.js";

export const PAGE_OBSERVATION_CHARACTER_BUDGET = 16_000;

export interface PageMarkdownObservationOptions {
	target?: string;
	query?: string;
	redactInputRefs?: string[];
	redactPasswordInputs?: boolean;
	stepNumber?: number;
}

export interface PageDocumentIdentity {
	targetId?: string;
	documentBackendNodeId: number;
}

export type PageObservationRequest =
	| { kind: "read_page" }
	| { kind: "find_page"; query: string }
	| {
			kind: "project_page";
			target: string;
			targetKind: "ref" | "selector";
	  };

export interface PageObservationMetadata {
	identity: PageDocumentIdentity;
	request: PageObservationRequest;
}

export interface PageMarkdownObservationDiagnostics {
	refCount: number;
	returnedRefCount: number;
	matchedNodeCount: number;
}

export interface PageMarkdownObservation {
	content: string;
	truncated: boolean;
	diagnostics: PageMarkdownObservationDiagnostics;
	metadata?: PageObservationMetadata;
}

interface DomScope {
	document: Protocol.DOM.Node;
	nodeIds: number[];
	backendNodeIds: number[];
	frameLabels: string[];
	frameIds: string[];
	matchedNodeCount: number;
}

interface CapturedNodeContent {
	html: string;
	frameLabel?: string;
}

const markItDown = new MarkItDown();

const CAPTURE_VISIBLE_HTML_FUNCTION = String.raw`function (preserveRichMetadata, redactEditableValues) {
	const originalRoot = this.nodeType === Node.DOCUMENT_NODE
		? (this.body || this.documentElement)
		: this;
	const omittedTags = new Set([
		"SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS"
	]);
	const compactAttributes = new Set([
		"href", "alt", "colspan", "rowspan", "start", "type"
	]);
	const richAttributes = new Set([
		...compactAttributes, "title", "src", "width", "height",
		"aria-label", "placeholder", "contenteditable", "role"
	]);
	const keptAttributes = preserveRichMetadata
		? richAttributes
		: compactAttributes;
	const trackingParameters = new Set([
		"rut", "ved", "sstk", "sxsrf", "sca_esv", "ei", "sa", "ref_",
		"gclid", "fbclid", "cm_sp", "icid"
	]);

	function compactLinkUrl(rawUrl) {
		try {
			let parsed = new URL(rawUrl, document.baseURI);
			if (
				parsed.hostname === "duckduckgo.com" &&
				parsed.pathname === "/l/" &&
				parsed.searchParams.has("uddg")
			) {
				parsed = new URL(parsed.searchParams.get("uddg"));
			}
			parsed.username = "";
			parsed.password = "";
			for (const name of [...parsed.searchParams.keys()]) {
				if (name.startsWith("utm_") || trackingParameters.has(name)) {
					parsed.searchParams.delete(name);
				}
			}
			return parsed.href;
		} catch {
			return rawUrl;
		}
	}

	function anchorLabel(element) {
		const visibleText = typeof element.innerText === "string"
			? element.innerText.replace(/\s+/g, " ").trim()
			: "";
		if (visibleText) return visibleText;
		return [...element.querySelectorAll("img[alt]")]
			.filter((image) => {
				const style = getComputedStyle(image);
				return !image.hidden &&
					style.display !== "none" &&
					style.visibility !== "hidden" &&
					style.contentVisibility !== "hidden";
			})
			.map((image) => image.getAttribute("alt") || "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	}

	function cloneVisible(node) {
		if (node.nodeType === Node.TEXT_NODE) {
			return node.cloneNode(false);
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return null;
		const element = node;
		if (omittedTags.has(element.tagName)) return null;
		if (element.hidden) return null;
		const style = getComputedStyle(element);
		if (
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.contentVisibility === "hidden"
		) {
			return null;
		}
		if (element.tagName === "IMG" && !preserveRichMetadata) {
			const alt = (element.getAttribute("alt") || "").trim();
			return alt ? document.createTextNode(alt) : null;
		}

		const clone = element.cloneNode(false);
		for (const attribute of [...clone.attributes]) {
			if (!keptAttributes.has(attribute.name.toLowerCase())) {
				clone.removeAttribute(attribute.name);
			}
		}
		if (element.tagName === "A" && element.href) {
			const protocol = String(element.protocol || "").toLowerCase();
			if (protocol === "http:" || protocol === "https:" || protocol === "file:") {
				clone.setAttribute(
					"href",
					preserveRichMetadata ? element.href : compactLinkUrl(element.href),
				);
			} else {
				clone.removeAttribute("href");
			}
			if (!preserveRichMetadata) clone.removeAttribute("title");
		}
		if (element.tagName === "IMG" && element.src) {
			clone.setAttribute("src", element.src);
		}
		const editable =
			element.isContentEditable || element.hasAttribute("contenteditable");
		const suppressChildren =
			element.tagName === "INPUT" ||
			element.tagName === "TEXTAREA" ||
			(editable && (!preserveRichMetadata || redactEditableValues));
		if (suppressChildren) {
			clone.removeAttribute("value");
			clone.textContent = "";
		}

		if (!suppressChildren && element.tagName === "A") {
			const label = anchorLabel(element);
			if (label) clone.appendChild(document.createTextNode(label));
		} else if (!suppressChildren) {
			for (const child of element.childNodes) {
				const childClone = cloneVisible(child);
				if (childClone) clone.appendChild(childClone);
			}
		}
		if (!suppressChildren && element.shadowRoot) {
			for (const child of element.shadowRoot.childNodes) {
				const childClone = cloneVisible(child);
				if (childClone) clone.appendChild(childClone);
			}
		}
		if (element.tagName === "IFRAME") {
			try {
				const frameRoot = element.contentDocument &&
					(element.contentDocument.body || element.contentDocument.documentElement);
				if (frameRoot) {
					const frameClone = cloneVisible(frameRoot);
					if (frameClone) clone.appendChild(frameClone);
				}
			} catch {
				// Cross-origin frame content remains represented by the ref footer.
			}
		}
		return clone;
	}

	const clone = originalRoot ? cloneVisible(originalRoot) : null;
	return {
		html: clone && "outerHTML" in clone ? clone.outerHTML : ""
	};
}`;

function normalizeMarkdown(markdown: string): string {
	return markdown
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\[([^\]\n]*)\]\(null(?: "[^"]*")?\)/g, "$1")
		.replace(
			/\]\((\S+) "([^"]*)"\)/g,
			(match, destination: string, title: string) =>
				destination === title ? `](${destination})` : match,
		)
		.replace(/\n[ \t]+\n/g, "\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function safeObservationUrl(url: string): string {
	if (/^data:/i.test(url)) return "data:[document]";
	try {
		const parsed = new URL(url);
		if (parsed.username || parsed.password) {
			parsed.username = "";
			parsed.password = "";
			return parsed.toString();
		}
	} catch {
		// Keep non-standard browser URLs as reported by the runtime.
	}
	return url;
}

function truncateAtLineBoundary(value: string, maxCharacters: number): string {
	if (maxCharacters <= 0) return "";
	if (value.length <= maxCharacters) return value;
	const candidate = value.slice(0, maxCharacters);
	const lastNewline = candidate.lastIndexOf("\n");
	if (lastNewline > Math.floor(maxCharacters * 0.6)) {
		return candidate.slice(0, lastNewline).trimEnd();
	}
	return candidate.trimEnd();
}

function projectionRefFromLine(line: string): string | undefined {
	return line.match(/\bref="([^"]+)"/)?.[1];
}

function projectionFields(line: string): Map<string, string> {
	const fields = new Map<string, string>();
	let cursor = line.indexOf(" ");
	if (cursor < 0) return fields;
	while (cursor < line.length) {
		while (line[cursor] === " ") cursor += 1;
		const keyStart = cursor;
		while (/[a-z]/i.test(line[cursor] ?? "")) cursor += 1;
		const key = line.slice(keyStart, cursor);
		if (!key || line[cursor] !== "=") {
			while (cursor < line.length && line[cursor] !== " ") cursor += 1;
			continue;
		}
		cursor += 1;
		const valueStart = cursor;
		if (line[cursor] === '"') {
			cursor += 1;
			while (cursor < line.length) {
				if (line[cursor] === "\\") {
					cursor += 2;
					continue;
				}
				if (line[cursor] === '"') {
					cursor += 1;
					break;
				}
				cursor += 1;
			}
		} else if (line[cursor] === "[") {
			let depth = 0;
			let inString = false;
			while (cursor < line.length) {
				const character = line[cursor];
				if (inString && character === "\\") {
					cursor += 2;
					continue;
				}
				if (character === '"') inString = !inString;
				if (!inString && character === "[") depth += 1;
				if (!inString && character === "]") {
					depth -= 1;
					cursor += 1;
					if (depth === 0) break;
					continue;
				}
				cursor += 1;
			}
		} else {
			while (cursor < line.length && line[cursor] !== " ") cursor += 1;
		}
		fields.set(key, line.slice(valueStart, cursor));
	}
	return fields;
}

const COMPACT_REF_FIELDS = [
	"value",
	"checked",
	"disabled",
	"expanded",
	"haspopup",
	"invalid",
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

const STATE_CHANGING_CAPABILITIES = new Set([
	"click",
	"type",
	"select",
	"set_value",
]);

function compactFieldValue(value: string, maximumCharacters = 120): string {
	if (value.length <= maximumCharacters) return value;
	if (value.startsWith('"')) {
		try {
			const parsed = JSON.parse(value);
			if (typeof parsed === "string") {
				return JSON.stringify(`${parsed.slice(0, maximumCharacters - 5)}…`);
			}
		} catch {
			// Fall through to a plain bounded value.
		}
	}
	return `${value.slice(0, maximumCharacters - 1)}…`;
}

function compactRefLine(
	line: string,
	ref: string,
	options: { hint?: string; editable?: boolean } = {},
): string {
	const role = line.slice(0, line.indexOf(" ") < 0 ? line.length : line.indexOf(" "));
	const fields = projectionFields(line);
	const name = fields.get("name");
	return [
		`[${ref}]`,
		role,
		...(name ? [compactFieldValue(name)] : []),
		...(!name && options.hint
			? [`hint=${compactFieldValue(JSON.stringify(options.hint))}`]
			: []),
		...(options.editable ? ["editable=true"] : []),
		...COMPACT_REF_FIELDS.flatMap((field) => {
			const value = fields.get(field);
			return value
				? [`${field}=${compactFieldValue(value)}`]
				: [];
		}),
	].join(" ");
}

function buildRefLines(
	browser: Browser,
	semanticProjection: string,
	allowedRefs?: Set<string>,
	scopeRootBackendNodeIds?: Set<number>,
): string[] {
	const targets = new Map(
		getSemanticRefTargets(browser)
			.filter((target) =>
				semanticProjection.includes(`ref=${JSON.stringify(target.ref)}`),
			)
			.map((target) => [target.ref, target]),
	);
	const projectionLines = semanticProjection.split("\n").map((raw, index) => ({
		raw,
		line: raw.trim(),
		index,
		depth: raw.length - raw.trimStart().length,
	}));
	const entries = projectionLines
		.map((entry) => ({ ...entry, ref: projectionRefFromLine(entry.line) }))
		.filter(
			(entry): entry is typeof entry & { ref: string } =>
				Boolean(entry.ref) &&
				(!allowedRefs || allowedRefs.has(entry.ref as string)) &&
				(Boolean(
					targets
						.get(entry.ref as string)
						?.capabilities.some((capability) =>
							STATE_CHANGING_CAPABILITIES.has(capability),
						),
				) ||
					Boolean(
						scopeRootBackendNodeIds?.has(
							targets.get(entry.ref as string)?.backendNodeId ?? -1,
						),
					)),
		);

	const sortedEntries = entries
		.sort((a, b) => {
			const aActionable =
				targets.get(a.ref)?.capabilities.some((capability) =>
					["click", "type", "select", "set_value"].includes(
						capability,
					),
				) ?? false;
			const bActionable =
				targets.get(b.ref)?.capabilities.some((capability) =>
					["click", "type", "select", "set_value"].includes(
						capability,
					),
				) ?? false;
			if (aActionable !== bActionable) return aActionable ? -1 : 1;
			return a.index - b.index;
		});
	const primaryLines = sortedEntries.map((entry) => {
		const target = targets.get(entry.ref);
		let hint: string | undefined;
		if (!projectionFields(entry.line).get("name")) {
			for (let index = entry.index + 1; index < projectionLines.length; index++) {
				const candidate = projectionLines[index];
				if (candidate.depth <= entry.depth) break;
				const candidateName = projectionFields(candidate.line).get("name");
				if (!candidateName) continue;
				try {
					const parsed = JSON.parse(candidateName);
					if (typeof parsed === "string" && parsed.trim()) hint = parsed.trim();
				} catch {
					hint = candidateName;
				}
				if (hint) break;
			}
		}
		return compactRefLine(entry.line, entry.ref, {
			hint,
			editable: target?.capabilities.includes("type") === true,
		});
	});
	const detailLines = sortedEntries.flatMap((entry) => {
		const options = projectionFields(entry.line).get("options");
		return options ? [`[${entry.ref}] options=${options}`] : [];
	});
	return [...primaryLines, ...detailLines];
}

function refsInRefBody(refBody: string): Set<string> {
	return new Set(
		[...refBody.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]),
	);
}

function serializeObservation(input: {
	url: string;
	title: string;
	markdown: string;
	refLines: string[];
	matchedNodeCount: number;
}): { content: string; truncated: boolean; returnedRefCount: number } {
	const refBody = input.refLines.join("\n");
	const makeHeader = (truncated: boolean): string =>
		[
			`page url=${JSON.stringify(input.url)} title=${JSON.stringify(input.title)}`,
			`matched=${input.matchedNodeCount} truncated=${truncated}`,
		].join("\n");
	const rawSections = [
		makeHeader(false),
		input.markdown,
		...(refBody ? ["--- refs ---", refBody] : []),
	].filter(Boolean);
	const raw = rawSections.join("\n\n");
	if (raw.length <= PAGE_OBSERVATION_CHARACTER_BUDGET) {
		return {
			content: raw,
			truncated: false,
			returnedRefCount: refsInRefBody(refBody).size,
		};
	}

	const header = makeHeader(true);
	const sectionOverhead = refBody
		? 2 + "\n\n--- refs ---\n\n".length
		: 2;
	const available = Math.max(
		0,
		PAGE_OBSERVATION_CHARACTER_BUDGET -
			header.length -
			sectionOverhead,
	);
	const maximumRefCharacters = Math.floor(available * 0.55);
	const fittedRefBody = truncateAtLineBoundary(
		refBody,
		maximumRefCharacters,
	);
	const markdownCharacters = Math.max(
		0,
		available - fittedRefBody.length,
	);
	const fittedMarkdown = truncateAtLineBoundary(
		input.markdown,
		markdownCharacters,
	);
	const content = [
		header,
		fittedMarkdown,
		...(fittedRefBody ? ["--- refs ---", fittedRefBody] : []),
	]
		.filter(Boolean)
		.join("\n\n")
		.slice(0, PAGE_OBSERVATION_CHARACTER_BUDGET);
	return {
		content,
		truncated: true,
		returnedRefCount: refsInRefBody(fittedRefBody).size,
	};
}

function collectDomParentByBackendNodeId(
	document: Protocol.DOM.Node,
): Map<number, number | undefined> {
	const parents = new Map<number, number | undefined>();
	const visit = (node: Protocol.DOM.Node, parent?: number): void => {
		parents.set(node.backendNodeId, parent);
		const children = [
			...(node.children ?? []),
			...(node.shadowRoots ?? []),
			...(node.contentDocument ? [node.contentDocument] : []),
		];
		for (const child of children) visit(child, node.backendNodeId);
	};
	visit(document);
	return parents;
}

function isWithinAnyScope(
	backendNodeId: number,
	scopeBackendNodeIds: Set<number>,
	parents: Map<number, number | undefined>,
): boolean {
	let current: number | undefined = backendNodeId;
	const visited = new Set<number>();
	while (current !== undefined && !visited.has(current)) {
		if (scopeBackendNodeIds.has(current)) return true;
		visited.add(current);
		current = parents.get(current);
	}
	return false;
}

interface DomDocumentRoot {
	document: Protocol.DOM.Node;
	frameLabel?: string;
	frameId?: string;
}

function nodeAttributes(node: Protocol.DOM.Node): Map<string, string> {
	const values = new Map<string, string>();
	for (let index = 0; index < (node.attributes?.length ?? 0); index += 2) {
		values.set(node.attributes![index].toLowerCase(), node.attributes![index + 1]);
	}
	return values;
}

function collectDomDocumentRoots(root: Protocol.DOM.Node): DomDocumentRoot[] {
	const documents: DomDocumentRoot[] = [{
		document: root,
		frameId: root.frameId,
	}];
	const visited = new Set<number>([root.backendNodeId]);
	const visit = (node: Protocol.DOM.Node): void => {
		if (node.contentDocument && !visited.has(node.contentDocument.backendNodeId)) {
			const attributes = nodeAttributes(node);
			const frameLabel =
				attributes.get("title") ||
				attributes.get("name") ||
				node.contentDocument.documentURL ||
				attributes.get("src") ||
				"embedded frame";
			visited.add(node.contentDocument.backendNodeId);
			documents.push({
				document: node.contentDocument,
				frameLabel,
				frameId: node.contentDocument.frameId,
			});
			visit(node.contentDocument);
		}
		for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
			visit(child);
		}
	};
	visit(root);
	return documents;
}

function frameLabelForBackendNode(
	documents: DomDocumentRoot[],
	backendNodeId: number,
): string | undefined {
	for (const candidate of documents) {
		const parents = collectDomParentByBackendNodeId(candidate.document);
		if (parents.has(backendNodeId)) return candidate.frameLabel;
	}
	return undefined;
}

export async function getPageDocumentIdentity(
	browser: Browser,
): Promise<PageDocumentIdentity> {
	const { root } = await browser.DOM.getDocument({ depth: 0, pierce: true });
	return {
		...(browser.currentTargetId ? { targetId: browser.currentTargetId } : {}),
		documentBackendNodeId: root.backendNodeId,
	};
}

export function isSamePageDocument(
	left: PageDocumentIdentity,
	right: PageDocumentIdentity,
): boolean {
	return (
		left.documentBackendNodeId === right.documentBackendNodeId &&
		(!left.targetId || !right.targetId || left.targetId === right.targetId)
	);
}

async function resolveDomScope(
	browser: Browser,
	target?: string,
): Promise<DomScope> {
	const { root: document } = await browser.DOM.getDocument({
		depth: -1,
		pierce: true,
	});
	const documents = collectDomDocumentRoots(document);
	const { frameTree } = await browser.Page.getFrameTree();
	const frameIds: string[] = [];
	const collectFrameIds = (tree: Protocol.Page.FrameTree): void => {
		frameIds.push(tree.frame.id);
		for (const child of tree.childFrames ?? []) collectFrameIds(child);
	};
	collectFrameIds(frameTree);
	if (!target) {
		const { nodeId: bodyNodeId } = await browser.DOM.querySelector({
			nodeId: document.nodeId,
			selector: "body",
		});
		const nodeId = bodyNodeId || document.nodeId;
		const { node } = await browser.DOM.describeNode({ nodeId });
		return {
			document,
			nodeIds: [nodeId],
			backendNodeIds: [node.backendNodeId],
			frameLabels: [""],
			frameIds,
			matchedNodeCount: 1,
		};
	}

	const normalizedTarget = target.trim();
	if (!normalizedTarget) {
		throw new Error("project_page requires a non-empty target");
	}
	if (getSemanticRefTarget(browser, normalizedTarget)) {
		const resolved = await resolveSemanticRef(browser, normalizedTarget);
		return {
			document,
			nodeIds: [resolved.nodeId],
			backendNodeIds: [resolved.target.backendNodeId],
			frameLabels: [
				frameLabelForBackendNode(documents, resolved.target.backendNodeId) ?? "",
			],
			frameIds,
			matchedNodeCount: 1,
		};
	}

	const nodeIds: number[] = [];
	const backendNodeIds: number[] = [];
	const frameLabels: string[] = [];
	for (const candidate of documents) {
		const result = await browser.DOM.querySelectorAll({
			nodeId: candidate.document.nodeId,
			selector: normalizedTarget,
		});
		for (const nodeId of result.nodeIds) {
			const { node } = await browser.DOM.describeNode({ nodeId });
			nodeIds.push(nodeId);
			backendNodeIds.push(node.backendNodeId);
			frameLabels.push(candidate.frameLabel ?? "");
		}
	}
	return {
		document,
		nodeIds,
		backendNodeIds,
		frameLabels,
		frameIds,
		matchedNodeCount: nodeIds.length,
	};
}

async function captureNodeContent(
	browser: Browser,
	nodeId: number,
	preserveRichMetadata: boolean,
	redactEditableValues: boolean,
): Promise<CapturedNodeContent> {
	const { object } = await browser.DOM.resolveNode({ nodeId });
	if (!object.objectId) {
		throw new Error(`Could not resolve DOM node ${nodeId}`);
	}
	try {
		const { result, exceptionDetails } = await browser.Runtime.callFunctionOn({
			objectId: object.objectId,
			functionDeclaration: CAPTURE_VISIBLE_HTML_FUNCTION,
			arguments: [
				{ value: preserveRichMetadata },
				{ value: redactEditableValues },
			],
			returnByValue: true,
			awaitPromise: false,
		});
		if (exceptionDetails) {
			throw new Error(
				exceptionDetails.exception?.description ||
					exceptionDetails.text ||
					"DOM capture failed",
			);
		}
		const value = result.value as Partial<CapturedNodeContent> | undefined;
		return {
			html: typeof value?.html === "string" ? value.html : "",
		};
	} finally {
		await browser.Runtime.releaseObject({ objectId: object.objectId }).catch(
			() => undefined,
		);
	}
}

async function convertHtmlToMarkdown(
	html: string,
	url: string,
): Promise<string> {
	if (!html.trim()) return "";
	const result = await markItDown.convertBuffer(Buffer.from(html), {
		file_extension: ".html",
		url,
	});
	if (!result) return "";
	return normalizeMarkdown(result.markdown);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMarkdownPassages(
	markdown: string,
	query: string,
): { markdown: string; matchCount: number } {
	let matcher: RegExp;
	try {
		matcher = new RegExp(query, "i");
	} catch {
		matcher = new RegExp(escapeRegExp(query), "i");
	}
	const blocks = markdown
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter(Boolean);
	const matchedIndexes = blocks
		.map((block, index) => (matcher.test(block) ? index : -1))
		.filter((index) => index >= 0);
	const included = new Set<number>();
	for (const index of matchedIndexes) {
		let headingIndex = index - 1;
		while (headingIndex >= 0 && !/^#{1,6}\s/.test(blocks[headingIndex])) {
			headingIndex -= 1;
		}
		if (headingIndex >= 0) included.add(headingIndex);
		for (let offset = -1; offset <= 1; offset++) {
			const candidate = index + offset;
			if (candidate >= 0 && candidate < blocks.length) included.add(candidate);
		}
	}
	return {
		markdown:
			matchedIndexes.length > 0
				? [...included]
						.sort((left, right) => left - right)
						.map((index) => blocks[index])
						.join("\n\n")
				: `No visible-text matches for ${JSON.stringify(query)}.`,
		matchCount: matchedIndexes.length,
	};
}

export async function getPageMarkdownObservation(
	browser: Browser,
	options: PageMarkdownObservationOptions = {},
): Promise<PageMarkdownObservation> {
	if (options.target && options.query) {
		throw new Error("page observation cannot combine target and query");
	}
	const targetWasRef = Boolean(
		options.target && getSemanticRefTarget(browser, options.target.trim()),
	);
	const scope = await resolveDomScope(browser, options.target);
	const capturedNodes: CapturedNodeContent[] = [];
	const redactEditableValues =
		options.redactPasswordInputs === true ||
		(options.redactInputRefs?.length ?? 0) > 0;
	for (let index = 0; index < scope.nodeIds.length; index++) {
		const captured = await captureNodeContent(
			browser,
			scope.nodeIds[index],
			Boolean(options.target),
			redactEditableValues,
		);
		capturedNodes.push({
			...captured,
			...(scope.frameLabels[index]
				? { frameLabel: scope.frameLabels[index] }
				: {}),
		});
	}
	const urlResult = await browser.Runtime.evaluate({
		expression: "location.href",
		returnByValue: true,
	});
	const titleResult = await browser.Runtime.evaluate({
		expression: "document.title",
		returnByValue: true,
	});
	const url =
		typeof urlResult.result.value === "string"
			? urlResult.result.value
			: "";
	const serializedUrl = safeObservationUrl(url);
	const title =
		typeof titleResult.result.value === "string"
			? titleResult.result.value
			: "";
	const html = capturedNodes
		.map((entry) =>
			entry.frameLabel
				? `<section><h6>Frame: ${entry.frameLabel
						.replaceAll("&", "&amp;")
						.replaceAll("<", "&lt;")
						.replaceAll(">", "&gt;")}</h6>${entry.html}</section>`
				: entry.html,
		)
		.join("<hr>");
	const convertedMarkdown = await convertHtmlToMarkdown(html, url);
	const found = options.query
		? findMarkdownPassages(convertedMarkdown, options.query)
		: undefined;
	const markdown = found?.markdown ?? convertedMarkdown;
	let refLines: string[] = [];
	if (options.target) {
		const semanticProjection = await getSemanticProjection(browser, {
			omitHrefs: false,
			redactInputRefs: options.redactInputRefs,
			redactPasswordInputs: options.redactPasswordInputs,
			stepNumber: options.stepNumber,
			frameIds: scope.frameIds,
		});
		const scopeIds = new Set(scope.backendNodeIds);
		const parents = collectDomParentByBackendNodeId(scope.document);
		const allowedRefs = new Set(
			getSemanticRefTargets(browser)
				.filter((target) =>
					isWithinAnyScope(
						target.backendNodeId,
						scopeIds,
						parents,
					),
				)
				.map((target) => target.ref),
		);
		refLines = buildRefLines(
			browser,
			semanticProjection,
			allowedRefs,
			scopeIds,
		);
	} else {
		// Broad observations intentionally contain content only. Action refs are
		// exposed on demand by project_page so stale projected refs cannot be
		// reused after a whole-page read.
		replaceSemanticRefSnapshot(browser, []);
	}
	const serialized = serializeObservation({
		url: serializedUrl,
		title,
		markdown,
		refLines,
		matchedNodeCount: found?.matchCount ?? scope.matchedNodeCount,
	});
	if (options.target) {
		const refSection =
			serialized.content.split("\n\n--- refs ---\n\n")[1] ?? "";
		const returnedRefs = refsInRefBody(refSection);
		replaceSemanticRefSnapshot(
			browser,
			getSemanticRefTargets(browser).filter((target) =>
				returnedRefs.has(target.ref),
			),
		);
	}
	return {
		content: serialized.content,
		truncated: serialized.truncated,
		metadata: {
			identity: {
				...(browser.currentTargetId
					? { targetId: browser.currentTargetId }
					: {}),
				documentBackendNodeId: scope.document.backendNodeId,
			},
			request: options.target
				? {
						kind: "project_page",
						target: options.target,
						targetKind: targetWasRef ? "ref" : "selector",
					}
				: options.query
					? { kind: "find_page", query: options.query }
					: { kind: "read_page" },
		},
		diagnostics: {
			refCount: refsInRefBody(refLines.join("\n")).size,
			returnedRefCount: serialized.returnedRefCount,
			matchedNodeCount: found?.matchCount ?? scope.matchedNodeCount,
		},
	};
}
