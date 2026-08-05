import { OPACITY_FOR_PRUNED_NODES } from "../constants.js";
import type { Browser } from "../types.js";
import { splitRefCandidates } from "./utils.js";

interface MatchedNode {
	nodeId: number;
	matchingBids: string[];
	matchingNonClickableIds: string[];
	existingStyle: string;
	hadInlineStyle: boolean;
	alreadyPruned: boolean;
}

interface PrunedNode {
	nodeId: number;
	originalStyle: string;
	hadOriginalStyle: boolean;
}

export interface LiveDomPruneResult {
	requestedBids: string[];
	requestedNonClickableIds: string[];
	matchedBids: string[];
	matchedNonClickableIds: string[];
	markedNodeCount: number;
	errors: string[];
}

export interface LiveDomUnpruneResult {
	matchedNodeCount: number;
	restoredNodeCount: number;
	errors: string[];
}

interface PruneLiveDomIdentifiers {
	bids?: string[];
	nonClickableIds?: string[];
}

const PRUNED_ATTRIBUTE_NAME = "data-ba-irrelevant-pruned";
const ORIGINAL_STYLE_ATTRIBUTE_NAME = "data-ba-original-style";
const ORIGINAL_STYLE_PRESENT_ATTRIBUTE_NAME = "data-ba-original-style-present";

function normalizeRequestedBids(bids: string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const rawBid of bids) {
		for (const bid of splitRefCandidates(rawBid)) {
			if (seen.has(bid)) continue;
			seen.add(bid);
			normalized.push(bid);
		}
	}
	return normalized;
}

function normalizeRequestedNonClickableIds(ids: string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const rawId of ids) {
		const id = rawId.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		normalized.push(id);
	}
	return normalized;
}

function readDataBidAttribute(attributes: string[]): string | null {
	for (let i = 0; i < attributes.length; i += 2) {
		if (attributes[i] === "data-bid") {
			return attributes[i + 1] ?? "";
		}
	}
	return null;
}

function readDataNonClickableIdAttribute(attributes: string[]): string | null {
	for (let i = 0; i < attributes.length; i += 2) {
		if (attributes[i] === "data-nonclickableid") {
			return attributes[i + 1] ?? "";
		}
	}
	return null;
}

async function collectMatchedNodes(
	b: Browser,
	requestedBidSet: Set<string>,
	requestedNonClickableIdSet: Set<string>,
): Promise<{
	matches: MatchedNode[];
	matchedBids: Set<string>;
	matchedNonClickableIds: Set<string>;
}> {
	const { root } = await b.DOM.getDocument({ depth: -1, pierce: true });
	const { nodeIds } = await b.DOM.querySelectorAll({
		nodeId: root.nodeId,
		selector: "[data-bid], [data-nonclickableid]",
	});

	const matches: MatchedNode[] = [];
	const matchedBids = new Set<string>();
	const matchedNonClickableIds = new Set<string>();

	for (const nodeId of nodeIds) {
		let attributes: string[];
		try {
			({ attributes } = await b.DOM.getAttributes({ nodeId }));
		} catch {
			continue;
		}
		const dataBidRaw = readDataBidAttribute(attributes);
		const matchingBids = dataBidRaw
			? splitRefCandidates(dataBidRaw).filter((bid) =>
					requestedBidSet.has(bid),
				)
			: [];
		const dataNonClickableIdRaw =
			readDataNonClickableIdAttribute(attributes);
		const matchingNonClickableIds = dataNonClickableIdRaw
			? [dataNonClickableIdRaw.trim()].filter(
					(id) => id && requestedNonClickableIdSet.has(id),
				)
			: [];
		if (matchingBids.length === 0 && matchingNonClickableIds.length === 0)
			continue;
		for (const bid of matchingBids) matchedBids.add(bid);
		for (const id of matchingNonClickableIds) {
			matchedNonClickableIds.add(id);
		}
		const existingStyle = readAttributeValue(attributes, "style");
		const hadInlineStyle = hasAttribute(attributes, "style");
		const alreadyPruned =
			readAttributeValue(attributes, PRUNED_ATTRIBUTE_NAME) === "true";
		matches.push({
			nodeId,
			matchingBids,
			matchingNonClickableIds,
			existingStyle,
			hadInlineStyle,
			alreadyPruned,
		});
	}

	return { matches, matchedBids, matchedNonClickableIds };
}

export async function pruneLiveDomByIdentifiers(
	b: Browser,
	identifiers: PruneLiveDomIdentifiers,
): Promise<LiveDomPruneResult> {
	const requestedBids = normalizeRequestedBids(identifiers.bids || []);
	const requestedNonClickableIds = normalizeRequestedNonClickableIds(
		identifiers.nonClickableIds || [],
	);
	if (requestedBids.length === 0 && requestedNonClickableIds.length === 0) {
		return {
			requestedBids: [],
			requestedNonClickableIds: [],
			matchedBids: [],
			matchedNonClickableIds: [],
			markedNodeCount: 0,
			errors: [],
		};
	}

	const requestedBidSet = new Set(requestedBids);
	const requestedNonClickableIdSet = new Set(requestedNonClickableIds);
	const { matches, matchedBids, matchedNonClickableIds } =
		await collectMatchedNodes(
			b,
			requestedBidSet,
			requestedNonClickableIdSet,
		);

	let markedNodeCount = 0;
	const errors: string[] = [];

	for (const match of matches) {
		try {
			if (!match.alreadyPruned) {
				await b.DOM.setAttributeValue({
					nodeId: match.nodeId,
					name: ORIGINAL_STYLE_PRESENT_ATTRIBUTE_NAME,
					value: match.hadInlineStyle ? "true" : "false",
				});
				await b.DOM.setAttributeValue({
					nodeId: match.nodeId,
					name: ORIGINAL_STYLE_ATTRIBUTE_NAME,
					value: match.existingStyle,
				});
			}
			await b.DOM.setAttributeValue({
				nodeId: match.nodeId,
				name: PRUNED_ATTRIBUTE_NAME,
				value: "true",
			});
			await b.DOM.setAttributeValue({
				nodeId: match.nodeId,
				name: "style",
				value: mergeOpacityStyle(match.existingStyle),
			});
			markedNodeCount += 1;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			errors.push(
				`nodeId=${match.nodeId} bids=${match.matchingBids.join(",")} nonClickableIds=${match.matchingNonClickableIds.join(",")}: ${message}`,
			);
		}
	}

	return {
		requestedBids,
		requestedNonClickableIds,
		matchedBids: requestedBids.filter((bid) => matchedBids.has(bid)),
		matchedNonClickableIds: requestedNonClickableIds.filter((id) =>
			matchedNonClickableIds.has(id),
		),
		markedNodeCount,
		errors,
	};
}

export async function pruneLiveDomByBids(
	b: Browser,
	bids: string[],
): Promise<LiveDomPruneResult> {
	return pruneLiveDomByIdentifiers(b, { bids });
}

async function collectPrunedNodes(b: Browser): Promise<PrunedNode[]> {
	const { root } = await b.DOM.getDocument({ depth: -1, pierce: true });
	const { nodeIds } = await b.DOM.querySelectorAll({
		nodeId: root.nodeId,
		selector: `[${PRUNED_ATTRIBUTE_NAME}="true"]`,
	});

	const prunedNodes: PrunedNode[] = [];
	for (const nodeId of nodeIds) {
		let attributes: string[];
		try {
			({ attributes } = await b.DOM.getAttributes({ nodeId }));
		} catch {
			continue;
		}
		prunedNodes.push({
			nodeId,
			originalStyle: readAttributeValue(
				attributes,
				ORIGINAL_STYLE_ATTRIBUTE_NAME,
			),
			hadOriginalStyle:
				readAttributeValue(
					attributes,
					ORIGINAL_STYLE_PRESENT_ATTRIBUTE_NAME,
				) === "true",
		});
	}

	return prunedNodes;
}

export async function unpruneLiveDom(
	b: Browser,
): Promise<LiveDomUnpruneResult> {
	const prunedNodes = await collectPrunedNodes(b);
	let restoredNodeCount = 0;
	const errors: string[] = [];

	for (const prunedNode of prunedNodes) {
		try {
			if (prunedNode.hadOriginalStyle) {
				await b.DOM.setAttributeValue({
					nodeId: prunedNode.nodeId,
					name: "style",
					value: prunedNode.originalStyle,
				});
			} else {
				await removeAttribute(b, prunedNode.nodeId, "style");
			}
			await removeAttribute(b, prunedNode.nodeId, PRUNED_ATTRIBUTE_NAME);
			await removeAttribute(
				b,
				prunedNode.nodeId,
				ORIGINAL_STYLE_ATTRIBUTE_NAME,
			);
			await removeAttribute(
				b,
				prunedNode.nodeId,
				ORIGINAL_STYLE_PRESENT_ATTRIBUTE_NAME,
			);
			restoredNodeCount += 1;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			errors.push(`nodeId=${prunedNode.nodeId}: ${message}`);
		}
	}

	return {
		matchedNodeCount: prunedNodes.length,
		restoredNodeCount,
		errors,
	};
}

async function removeAttribute(
	b: Browser,
	nodeId: number,
	name: string,
): Promise<void> {
	try {
		await b.DOM.removeAttribute({ nodeId, name });
	} catch {
		// ignore missing attributes
	}
}

function readAttributeValue(
	attributes: string[],
	attributeName: string,
): string {
	for (let i = 0; i < attributes.length; i += 2) {
		if (attributes[i] === attributeName) {
			return attributes[i + 1] ?? "";
		}
	}
	return "";
}

function hasAttribute(attributes: string[], attributeName: string): boolean {
	for (let i = 0; i < attributes.length; i += 2) {
		if (attributes[i] === attributeName) return true;
	}
	return false;
}

function mergeOpacityStyle(existingStyle: string): string {
	const trimmed = existingStyle.trim();
	if (!trimmed) return `opacity: ${OPACITY_FOR_PRUNED_NODES};`;
	if (/\bopacity\s*:/i.test(trimmed)) {
		const replaced = trimmed.replace(
			/\bopacity\s*:\s*[^;]+/gi,
			`opacity: ${OPACITY_FOR_PRUNED_NODES}`,
		);
		return replaced.endsWith(";") ? replaced : `${replaced};`;
	}
	const suffix = trimmed.endsWith(";") ? "" : ";";
	return `${trimmed}${suffix} opacity: ${OPACITY_FOR_PRUNED_NODES};`;
}
