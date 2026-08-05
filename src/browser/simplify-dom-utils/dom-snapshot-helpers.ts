import type Protocol from "devtools-protocol";
import type { Browser } from "../types.js";
import {
	DOM_INTERACTIVE_ROLES,
	NATIVE_INTERACTIVE,
	NO_CLICK_ALLOWED_CURSORS,
	STYLE_CURSOR,
	STYLE_DISPLAY,
	STYLE_OPACITY,
	STYLE_OVERFLOW_X,
	STYLE_OVERFLOW_Y,
	STYLE_VISIBILITY,
} from "../constants.js";

type SnapshotNodes = Protocol.DOMSnapshot.DocumentSnapshot["nodes"];
type SnapshotLayout = Protocol.DOMSnapshot.DocumentSnapshot["layout"];

export interface DomSnapshotHelpers {
	getLiveInputValuesByNodeIndex: () => Promise<Map<number, string>>;
	getScrollableByNodeIndex: () => Promise<Map<number, boolean>>;
	getAttrs: (i: number) => Map<string, string>;
	getStyle: (nodeIdx: number, styleIdx: number) => string;
	isHidden: (i: number) => boolean;
	couldBeHidden: (i: number) => boolean;
	scrollEnabled: (i: number) => boolean;
	isInteractive: (
		i: number,
		tag: string,
		attrMap: Map<string, string>,
	) => boolean;
	noClickAllowedCursor: (i: number) => boolean;
	getRareString: (
		rare: Protocol.DOMSnapshot.RareStringData | undefined,
		idx: number,
	) => string | undefined;
}

export function buildLayoutByNode(layout: SnapshotLayout): Map<number, number> {
	const layoutByNode = new Map<number, number>();
	for (let j = 0; j < layout.nodeIndex.length; j++) {
		layoutByNode.set(layout.nodeIndex[j], j);
	}
	return layoutByNode;
}

export function buildClickableSet(nodes: SnapshotNodes): Set<number> {
	return new Set<number>(nodes.isClickable?.index ?? []);
}

function cursorIndicatesNoClickAllowed(styleCursor: string): boolean {
	const normalized = styleCursor.trim().toLowerCase();
	if (NO_CLICK_ALLOWED_CURSORS.has(normalized)) return true;
	for (const part of normalized.split(",")) {
		const tokens = part.trim().split(/\s+/).filter(Boolean);
		const last = tokens[tokens.length - 1] ?? "";
		if (NO_CLICK_ALLOWED_CURSORS.has(last)) return true;
	}
	return false;
}

export function buildChildrenOf(
	parentIndex: number[] | undefined,
	nodeCount: number,
): Map<number, number[]> {
	const childrenOf = new Map<number, number[]>();
	const parentIndices = parentIndex ?? [];
	for (let i = 0; i < nodeCount; i++) {
		const parent = parentIndices[i];
		if (parent !== undefined && parent >= 0) {
			const siblings = childrenOf.get(parent) || [];
			siblings.push(i);
			childrenOf.set(parent, siblings);
		}
	}
	return childrenOf;
}

export function findBodyNodeIndex(
	nodeCount: number,
	nodeNames: number[] | undefined,
	strings: string[],
): number {
	if (!nodeNames) return -1;
	for (let i = 0; i < nodeCount; i++) {
		if (strings[nodeNames[i]] === "BODY") return i;
	}
	return -1;
}

export async function getLiveInputValuesByBackendNodeId(params: {
	b: Browser;
	backendNodeIds: number[];
}): Promise<Map<number, string>> {
	const { b } = params;
	const dedupedBackendIds: number[] = [];
	const seen = new Set<number>();
	for (const backendId of params.backendNodeIds) {
		if (!backendId || seen.has(backendId)) continue;
		seen.add(backendId);
		dedupedBackendIds.push(backendId);
	}
	const liveValues = new Map<number, string>();
	if (dedupedBackendIds.length === 0) return liveValues;

	try {
		const { nodeIds } = await b.DOM.pushNodesByBackendIdsToFrontend({
			backendNodeIds: dedupedBackendIds,
		});

		for (let idx = 0; idx < nodeIds.length; idx++) {
			const nodeId = nodeIds[idx];
			if (!nodeId) continue;

			try {
				const { object } = await b.DOM.resolveNode({ nodeId });
				const objectId = object.objectId;
				if (!objectId) continue;
				const { result } = await b.Runtime.callFunctionOn({
					objectId,
					functionDeclaration: `function() {
            if (this instanceof HTMLInputElement) return this.value + "";
            if (this instanceof HTMLTextAreaElement) return this.value + "";
            if (this instanceof HTMLSelectElement) return this.value + "";
            if (typeof this.value === "string") return this.value;
            return "";
          }`,
					returnByValue: true,
				});
				if (typeof result.value === "string") {
					liveValues.set(dedupedBackendIds[idx], result.value);
				}
			} catch {
				// Best effort: keep snapshot-derived value when runtime resolution fails.
			}
		}
	} catch {
		// Best effort: keep snapshot-derived values when node mapping fails.
	}

	return liveValues;
}

export async function getLiveInputValuesByNodeIndex(params: {
	b: Browser;
	nodeCount: number;
	nodeNames: number[] | undefined;
	nodes: SnapshotNodes;
	strings: string[];
}): Promise<Map<number, string>> {
	const { b, nodeCount, nodeNames, nodes, strings } = params;
	const inputNodeIndices: number[] = [];
	const inputBackendIds: number[] = [];

	for (let i = 0; i < nodeCount; i++) {
		const nameIdx = nodeNames?.[i];
		if (nameIdx === undefined || strings[nameIdx] !== "INPUT") continue;
		const backendId = nodes.backendNodeId?.[i];
		if (!backendId) continue;
		inputNodeIndices.push(i);
		inputBackendIds.push(backendId);
	}

	const liveByBackend = await getLiveInputValuesByBackendNodeId({
		b,
		backendNodeIds: inputBackendIds,
	});

	const liveByNodeIndex = new Map<number, string>();
	for (let idx = 0; idx < inputNodeIndices.length; idx++) {
		const value = liveByBackend.get(inputBackendIds[idx]);
		if (typeof value !== "string") continue;
		liveByNodeIndex.set(inputNodeIndices[idx], value);
	}

	return liveByNodeIndex;
}

function overflowStyleEnablesScrolling(styleValue: string): boolean {
	const normalized = styleValue.trim().toLowerCase();
	return (
		normalized === "auto" ||
		normalized === "scroll" ||
		normalized === "overlay"
	);
}

export async function getLiveScrollableByBackendNodeId(params: {
	b: Browser;
	backendNodeIds: number[];
}): Promise<Map<number, boolean>> {
	const { b } = params;
	const dedupedBackendIds: number[] = [];
	const seen = new Set<number>();
	for (const backendId of params.backendNodeIds) {
		if (!backendId || seen.has(backendId)) continue;
		seen.add(backendId);
		dedupedBackendIds.push(backendId);
	}

	const scrollableByBackendId = new Map<number, boolean>();
	if (dedupedBackendIds.length === 0) return scrollableByBackendId;

	try {
		try {
			await b.DOM.getDocument();
		} catch {
			// Best effort: some mocks/environments may not expose getDocument.
		}
		const { nodeIds } = await b.DOM.pushNodesByBackendIdsToFrontend({
			backendNodeIds: dedupedBackendIds,
		});

		for (let idx = 0; idx < nodeIds.length; idx++) {
			const nodeId = nodeIds[idx];
			if (!nodeId) continue;

			try {
				const { object } = await b.DOM.resolveNode({ nodeId });
				const objectId = object.objectId;
				if (!objectId) continue;
				const { result } = await b.Runtime.callFunctionOn({
					objectId,
					functionDeclaration: `function() {
            if (!(this instanceof Element)) return false;
            return (this.scrollWidth > this.clientWidth) || (this.scrollHeight > this.clientHeight);
          }`,
					returnByValue: true,
				});
				if (typeof result.value === "boolean") {
					scrollableByBackendId.set(
						dedupedBackendIds[idx],
						result.value,
					);
				}
			} catch {
				// Best effort: keep snapshot-only markers if runtime resolution fails.
			}
		}
	} catch {
		// Best effort: keep snapshot-only markers if backend mapping fails.
	}

	return scrollableByBackendId;
}

export function createDomSnapshotHelpers(params: {
	b: Browser;
	nodeCount: number;
	nodeNames: number[] | undefined;
	nodes: SnapshotNodes;
	strings: string[];
	layout: SnapshotLayout;
	layoutByNode: Map<number, number>;
	clickableSet: Set<number>;
}): DomSnapshotHelpers {
	const {
		b,
		nodeCount,
		nodeNames,
		nodes,
		strings,
		layout,
		layoutByNode,
		clickableSet,
	} = params;
	const childrenOf = buildChildrenOf(nodes.parentIndex, nodeCount);

	function getAttrs(i: number): Map<string, string> {
		const raw = nodes.attributes?.[i];
		if (!raw) return new Map();
		const map = new Map<string, string>();
		for (let j = 0; j < raw.length; j += 2) {
			map.set(strings[raw[j]], strings[raw[j + 1]]);
		}
		return map;
	}

	function getStyle(nodeIdx: number, styleIdx: number): string {
		const li = layoutByNode.get(nodeIdx);
		if (li === undefined) return "";
		const styleValues = layout.styles[li];
		if (!styleValues || styleIdx >= styleValues.length) return "";
		return strings[styleValues[styleIdx]] ?? "";
	}

	function getTagName(i: number): string {
		const tagIdx = nodeNames?.[i];
		if (tagIdx === undefined) return "UNKNOWN";
		return strings[tagIdx] || "UNKNOWN";
	}

	function buildLiveDomLookupTip(
		i: number,
		attrMap: Map<string, string>,
	): string {
		const dataBidRaw = attrMap.get("data-bid");
		if (dataBidRaw) {
			const firstBid = dataBidRaw
				.split(",")
				.map((part) => part.trim())
				.find(Boolean);
			if (firstBid) {
				const bidLiteral = JSON.stringify(firstBid);
				return `In DevTools Console, run: const el = [...document.querySelectorAll('[data-bid]')].find(n => (n.getAttribute('data-bid') || '').split(',').map(s => s.trim()).includes(${bidLiteral})); console.log(el);`;
			}
		}

		const nonClickableId = attrMap.get("data-nonclickableid");
		if (nonClickableId) {
			const nonClickableIdLiteral = JSON.stringify(nonClickableId);
			return `In DevTools Console, run: const el = [...document.querySelectorAll('[data-nonclickableid]')].find(n => n.getAttribute('data-nonclickableid') === ${nonClickableIdLiteral}); console.log(el);`;
		}

		const idAttr = attrMap.get("id");
		if (idAttr) {
			const idLiteral = JSON.stringify(idAttr);
			return `In DevTools Console, run: const el = document.getElementById(${idLiteral}); console.log(el);`;
		}

		const classAttr = attrMap.get("class");
		if (classAttr) {
			const firstClass = classAttr
				.split(/\s+/)
				.map((part) => part.trim())
				.find(Boolean);
			if (firstClass) {
				const classLiteral = JSON.stringify(firstClass);
				return `In DevTools Console, run: const el = document.getElementsByClassName(${classLiteral})[0]; console.log(el);`;
			}
		}

		const backendNodeId = nodes.backendNodeId?.[i];
		const backendHint =
			backendNodeId !== undefined
				? ` backendNodeId=${backendNodeId}.`
				: "";
		return `No data-bid/data-nonclickableid/id/class found.${backendHint} Tip: inspect this node in the saved simplified DOM snapshot and match by tag/attributes.`;
	}

	const strictHiddenCache = new Map<number, boolean>();
	const couldBeHiddenCache = new Map<number, boolean>();
	const hierarchyCouldBeHiddenCache = new Map<number, boolean>();
	const hiddenCache = new Map<number, boolean>();
	const scrollEnabledCache = new Map<number, boolean>();

	function scrollEnabled(i: number): boolean {
		const cached = scrollEnabledCache.get(i);
		if (cached !== undefined) return cached;
		const enabled =
			overflowStyleEnablesScrolling(getStyle(i, STYLE_OVERFLOW_X)) ||
			overflowStyleEnablesScrolling(getStyle(i, STYLE_OVERFLOW_Y));
		scrollEnabledCache.set(i, enabled);
		return enabled;
	}

	function isStrictHidden(i: number): boolean {
		const cached = strictHiddenCache.get(i);
		if (cached !== undefined) return cached;

		const display = getStyle(i, STYLE_DISPLAY);
		if (display === "none") {
			strictHiddenCache.set(i, true);
			return true;
		}

		const opacity = getStyle(i, STYLE_OPACITY);
		if (opacity === "0") {
			strictHiddenCache.set(i, true);
			return true;
		}

		strictHiddenCache.set(i, false);
		return false;
	}

	function couldBeHidden(i: number): boolean {
		const cached = couldBeHiddenCache.get(i);
		if (cached !== undefined) return cached;

		if (isStrictHidden(i)) {
			couldBeHiddenCache.set(i, false);
			return false;
		}

		const li = layoutByNode.get(i);
		if (li === undefined) {
			couldBeHiddenCache.set(i, true);
			return true;
		}

		const [, , w, h] = layout.bounds[li];
		if (w === 0 || h === 0) {
			couldBeHiddenCache.set(i, true);
			return true;
		}

		const visibility = getStyle(i, STYLE_VISIBILITY);
		if (visibility === "hidden") {
			couldBeHiddenCache.set(i, true);
			return true;
		}

		couldBeHiddenCache.set(i, false);
		return false;
	}

	function isCouldBeHiddenHierarchy(i: number): boolean {
		const cached = hierarchyCouldBeHiddenCache.get(i);
		if (cached !== undefined) return cached;

		if (!couldBeHidden(i)) {
			hierarchyCouldBeHiddenCache.set(i, false);
			return false;
		}

		const children = childrenOf.get(i) ?? [];
		for (const childIdx of children) {
			const nodeType = nodes.nodeType?.[childIdx] ?? 0;
			if (nodeType !== 1) continue;
			if (!isCouldBeHiddenHierarchy(childIdx)) {
				hierarchyCouldBeHiddenCache.set(i, false);
				return false;
			}
		}

		hierarchyCouldBeHiddenCache.set(i, true);
		return true;
	}

	function findEnclosingSelectIndex(optionIndex: number): number | undefined {
		let cur = nodes.parentIndex?.[optionIndex];
		while (cur !== undefined && cur >= 0) {
			if ((nodes.nodeType?.[cur] ?? 0) !== 1) {
				cur = nodes.parentIndex?.[cur];
				continue;
			}
			const nameIdx = nodeNames?.[cur];
			if (nameIdx === undefined) {
				cur = nodes.parentIndex?.[cur];
				continue;
			}
			const tag = (strings[nameIdx] || "").toUpperCase();
			if (tag === "SELECT") return cur;
			cur = nodes.parentIndex?.[cur];
		}
		return undefined;
	}

	function isHidden(i: number): boolean {
		const cached = hiddenCache.get(i);
		if (cached !== undefined) return cached;

		const nodeType = nodes.nodeType?.[i] ?? 0;
		if (nodeType === 1 && nodeNames) {
			const tag = (strings[nodeNames[i]] || "").toUpperCase();
			if (tag === "OPTION") {
				const selectIdx = findEnclosingSelectIndex(i);
				if (selectIdx !== undefined) {
					const inherited = isHidden(selectIdx);
					hiddenCache.set(i, inherited);
					return inherited;
				}
			}
		}

		if (isStrictHidden(i)) {
			hiddenCache.set(i, true);
			return true;
		}

		const hiddenByCouldBeHierarchy = isCouldBeHiddenHierarchy(i);
		if (hiddenByCouldBeHierarchy) {
			hiddenCache.set(i, true);
			return true;
		}

		hiddenCache.set(i, false);
		return false;
	}

	function isInteractive(
		i: number,
		tag: string,
		attrMap: Map<string, string>,
	): boolean {
		if (NATIVE_INTERACTIVE.has(tag)) return true;
		if (clickableSet.has(i)) return true;
		const role = attrMap.get("role");
		if (role && DOM_INTERACTIVE_ROLES.has(role)) return true;
		const tabindex = attrMap.get("tabindex");
		if (tabindex !== undefined && parseInt(tabindex, 10) >= 0) return true;
		if (attrMap.get("contenteditable") === "true") return true;
		const cursorRaw = getStyle(i, STYLE_CURSOR);
		const cursor = cursorRaw.trim().toLowerCase();
		if (cursor === "pointer") return true;
		if (cursorIndicatesNoClickAllowed(cursorRaw)) return true;
		return false;
	}

	function noClickAllowedCursor(i: number): boolean {
		return cursorIndicatesNoClickAllowed(getStyle(i, STYLE_CURSOR));
	}

	function getRareString(
		rare: Protocol.DOMSnapshot.RareStringData | undefined,
		idx: number,
	): string | undefined {
		if (!rare) return undefined;
		const pos = rare.index.indexOf(idx);
		return pos !== -1 ? strings[rare.value[pos]] : undefined;
	}

	async function getScrollableByNodeIndex(): Promise<Map<number, boolean>> {
		const candidateNodeIndices: number[] = [];
		const backendNodeIds: number[] = [];

		for (let i = 0; i < nodeCount; i++) {
			if (!scrollEnabled(i)) continue;
			const backendNodeId = nodes.backendNodeId?.[i];
			if (!backendNodeId) continue;
			candidateNodeIndices.push(i);
			backendNodeIds.push(backendNodeId);
		}

		const scrollableByBackendId = await getLiveScrollableByBackendNodeId({
			b,
			backendNodeIds,
		});
		const scrollableByNodeIndex = new Map<number, boolean>();
		for (let i = 0; i < candidateNodeIndices.length; i++) {
			const backendNodeId = backendNodeIds[i];
			scrollableByNodeIndex.set(
				candidateNodeIndices[i],
				scrollableByBackendId.get(backendNodeId) === true,
			);
		}

		return scrollableByNodeIndex;
	}

	return {
		getLiveInputValuesByNodeIndex: () =>
			getLiveInputValuesByNodeIndex({
				b,
				nodeCount,
				nodeNames,
				nodes,
				strings,
			}),
		getScrollableByNodeIndex,
		getAttrs,
		getStyle,
		isHidden,
		couldBeHidden,
		scrollEnabled,
		isInteractive,
		noClickAllowedCursor,
		getRareString,
	};
}
