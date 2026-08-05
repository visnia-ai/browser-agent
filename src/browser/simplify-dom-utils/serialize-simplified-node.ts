import type { SimplifiedNode } from "./simplified-node.js";

const ATTR_TAG_SUPPRESSION_TAGS = new Set([
	"a",
	"b",
	"article",
	"i",
	"li",
	"ul",
	"ol",
	"p",
	"u",
]);
const OMIT_LONG_HREF_THRESHOLD = 150;

interface HeadFormatOptions {
	forceTagName?: boolean;
	omitHrefs?: boolean;
	preserveFullHrefs?: boolean;
	suppressCouldBeHiddenMarker?: boolean;
}

export interface SerializeSimplifiedNodeOptions {
	omitHrefs?: boolean;
	preserveFullHrefs?: boolean;
}

interface AnchorOutlineItem {
	label: string;
	values: string[];
}

function getAttrValue(
	attrs: [string, string][],
	name: string,
): string | undefined {
	const idx = attrs.findIndex(([k]) => k === name);
	if (idx < 0) return undefined;
	return attrs[idx][1];
}

function shouldSuppressDivSpanTag(node: SimplifiedNode): boolean {
	return (
		(node.tag === "div" || node.tag === "span") &&
		(node.attrs.length > 0 || !!node.text)
	);
}

function shouldSuppressTagForAttrRule(node: SimplifiedNode): boolean {
	return node.attrs.length > 0 && ATTR_TAG_SUPPRESSION_TAGS.has(node.tag);
}

function shouldSuppressImageTagName(node: SimplifiedNode): boolean {
	return node.tag === "img";
}

function shouldSuppressTagName(
	node: SimplifiedNode,
	options: HeadFormatOptions = {},
): boolean {
	if (options.forceTagName) return false;
	if (options.omitHrefs && node.tag === "a") return false;
	return (
		shouldSuppressDivSpanTag(node) ||
		shouldSuppressTagForAttrRule(node) ||
		shouldSuppressImageTagName(node)
	);
}

function quoteYamlText(text: string): string {
	return JSON.stringify(compressRepeatedEscapeRuns(text));
}

const ESCAPE_RUN_MIN_OCCURRENCES = 41;

function compressRepeatedEscapeRuns(text: string): string {
	const runPattern = new RegExp(
		`\\r{${ESCAPE_RUN_MIN_OCCURRENCES},}|\\n{${ESCAPE_RUN_MIN_OCCURRENCES},}|\\t{${ESCAPE_RUN_MIN_OCCURRENCES},}`,
		"g",
	);

	return text.replace(runPattern, (match) => {
		const firstChar = match[0];
		const escapeSequence =
			firstChar === "\r" ? "\\r" : firstChar === "\n" ? "\\n" : "\\t";
		return `{ ${escapeSequence} * ${match.length} }`;
	});
}

function formatSerializedHead(
	node: SimplifiedNode,
	depth: number,
	options: HeadFormatOptions = {},
): string {
	const indent = "  ".repeat(depth);
	const suppressTag = shouldSuppressTagName(node, options);
	let head = suppressTag ? indent : `${indent}${node.tag}`;

	for (const [rawName, value] of node.attrs) {
		if (options.omitHrefs && rawName === "href") continue;
		const rewrittenName =
			node.tag === "img" && rawName === "src" ? "img" : rawName;
		const name = rewrittenName === "aria-label" ? "label" : rewrittenName;
		if (
			name === "type" &&
			value &&
			value.trim().toLowerCase() === node.tag.toLowerCase()
		) {
			continue;
		}
		if (name === "role" && value) {
			head += head.trim() ? ` ${value}` : `${value}`;
			continue;
		}
		const shouldOmitHrefValue =
			!options.preserveFullHrefs &&
			name === "href" &&
			value.length > OMIT_LONG_HREF_THRESHOLD;
		const shouldRenderExplicitEmptyHref = name === "href" && value === "";
		// Match KEEP_ATTRS + buildNode: option value is always present; empty must be value="" so it
		// is not confused with a boolean attribute and matches HTML / select.value semantics.
		const shouldRenderExplicitEmptyOptionValue =
			node.tag === "option" && name === "value" && value === "";
		const prefix = head.trim() ? " " : "";
		head +=
			(value && !shouldOmitHrefValue) ||
			shouldRenderExplicitEmptyHref ||
			shouldRenderExplicitEmptyOptionValue
				? `${prefix}${name}="${value}"`
				: `${prefix}${name}`;
	}

	if (node.couldBeHidden && !options.suppressCouldBeHiddenMarker) {
		const prefix = head.trim() ? " " : "";
		head += `${prefix}couldBeHidden`;
	}

	if (node.noClickAllowed) {
		const prefix = head.trim() ? " " : "";
		head += `${prefix}no-click-allowed`;
	}

	if (node.scrollEnabled) {
		const prefix = head.trim() ? " " : "";
		head += `${prefix}scroll-enabled`;
	}

	if (node.scrollable) {
		const prefix = head.trim() ? " " : "";
		head += `${prefix}scrollable`;
	}

	return head.trimEnd();
}

function bidTokensFromNode(node: SimplifiedNode): string[] {
	const bid = getAttrValue(node.attrs, "bid");
	if (!bid) return [];
	return bid
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function mergeAnchorBidValues(node: SimplifiedNode): string | undefined {
	const seen = new Set<string>();
	const ordered: string[] = [];

	const appendNodeBid = (candidate: SimplifiedNode): void => {
		for (const token of bidTokensFromNode(candidate)) {
			if (seen.has(token)) continue;
			seen.add(token);
			ordered.push(token);
		}
	};

	const appendDescendantsDepthFirst = (candidate: SimplifiedNode): void => {
		for (const child of candidate.children) {
			appendNodeBid(child);
			appendDescendantsDepthFirst(child);
		}
	};

	appendNodeBid(node);
	for (const child of node.children) appendNodeBid(child);
	for (const child of node.children) {
		for (const grandChild of child.children) {
			appendNodeBid(grandChild);
			appendDescendantsDepthFirst(grandChild);
		}
	}

	return ordered.length > 0 ? ordered.join(",") : undefined;
}

function upsertBidAttr(
	attrs: [string, string][],
	bid: string | undefined,
): [string, string][] {
	if (!bid) return attrs;
	const next = attrs.map(
		([name, value]) => [name, value] as [string, string],
	);
	const bidIdx = next.findIndex(([name]) => name === "bid");
	if (bidIdx >= 0) {
		next[bidIdx][1] = bid;
		return next;
	}
	next.unshift(["bid", bid]);
	return next;
}

function hasAnyText(node: SimplifiedNode): boolean {
	if (node.text.trim()) return true;
	for (const child of node.children) {
		if (hasAnyText(child)) return true;
	}
	return false;
}

function isBidOnlyNode(node: SimplifiedNode): boolean {
	return (
		node.attrs.length === 1 &&
		node.attrs[0][0] === "bid" &&
		node.attrs[0][1].trim().length > 0
	);
}

function collectLeafTextsFromNodes(nodes: SimplifiedNode[]): string[] {
	const ordered: string[] = [];
	const seen = new Set<string>();

	const walk = (node: SimplifiedNode): void => {
		const text = node.text.trim();
		const childHasText = node.children.some((child) => hasAnyText(child));
		if (text && !childHasText && !seen.has(text)) {
			seen.add(text);
			ordered.push(text);
		}
		for (const child of node.children) walk(child);
	};

	for (const node of nodes) walk(node);
	return ordered;
}

function extractAnchorOutlineItems(node: SimplifiedNode): AnchorOutlineItem[] {
	const text = node.text.trim();
	if (text) {
		const descendantLeafTexts = collectLeafTextsFromNodes(node.children);
		return [
			{
				label: text,
				values: descendantLeafTexts,
			},
		];
	}

	const directTextChildren = node.children.filter(
		(child) => child.text.trim().length > 0,
	);
	if (node.children.length === 2 && directTextChildren.length === 2) {
		const [first, second] = node.children;
		const firstText = first.text.trim();
		const secondText = second.text.trim();
		const firstValues = collectLeafTextsFromNodes(first.children);
		const secondValues = collectLeafTextsFromNodes(second.children);
		if (
			firstText &&
			secondText &&
			firstValues.length === 0 &&
			secondValues.length === 0
		) {
			return [
				{
					label: firstText,
					values: [secondText],
				},
			];
		}
	}

	const items: AnchorOutlineItem[] = [];
	for (const child of node.children) {
		items.push(...extractAnchorOutlineItems(child));
	}
	return items;
}

function buildAnchorOutlineReformat(node: SimplifiedNode): {
	headNode: SimplifiedNode;
	items: AnchorOutlineItem[];
} | null {
	if (node.tag !== "a") return null;
	if (!node.children.length) return null;
	const href = getAttrValue(node.attrs, "href");
	if (!href || !href.trim()) return null;
	const descendants = collectAllDescendants(node);
	if (descendants.length === 0) return null;
	if (descendants.some((descendant) => descendant.isHidden)) return null;
	if (!descendants.every((descendant) => isBidOnlyNode(descendant)))
		return null;
	if (!descendants.some((descendant) => descendant.text.trim())) return null;

	const rawItems = node.children.flatMap((child) =>
		extractAnchorOutlineItems(child),
	);
	const items = rawItems
		.map((item) => ({
			label: item.label.trim(),
			values: item.values.map((value) => value.trim()).filter(Boolean),
		}))
		.filter((item) => item.label && item.values.length > 0);
	if (items.length === 0) return null;

	const mergedBid = mergeAnchorBidValues(node);
	const headNode: SimplifiedNode = {
		...node,
		attrs: upsertBidAttr(node.attrs, mergedBid),
	};
	return { headNode, items };
}

function collectAllDescendants(node: SimplifiedNode): SimplifiedNode[] {
	const ordered: SimplifiedNode[] = [];
	const walk = (current: SimplifiedNode): void => {
		for (const child of current.children) {
			ordered.push(child);
			walk(child);
		}
	};
	walk(node);
	return ordered;
}

function isTextOnlyLeaf(c: SimplifiedNode): boolean {
	// Options are serialized one per line (label + value="..."); merging them yielded a
	// single comma-joined pseudo-leaf and lost per-option structure for the model.
	if (c.tag === "option") return false;
	return !c.isInteractive && c.children.length === 0 && !!c.text;
}

function canMergeTextOnlyLeaves(
	base: SimplifiedNode,
	candidate: SimplifiedNode,
): boolean {
	if (!isTextOnlyLeaf(base) || !isTextOnlyLeaf(candidate)) return false;
	return base.tag === candidate.tag;
}

function mergeBidValues(nodes: SimplifiedNode[]): string | undefined {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const node of nodes) {
		const bid = getAttrValue(node.attrs, "bid");
		if (!bid) continue;
		for (const part of bid.split(",")) {
			const value = part.trim();
			if (!value || seen.has(value)) continue;
			seen.add(value);
			ordered.push(value);
		}
	}
	return ordered.length > 0 ? ordered.join(",") : undefined;
}

function serializeChildren(
	children: SimplifiedNode[],
	baseDepth: number,
	hiddenCtx: boolean,
	couldBeHiddenCtx: boolean,
	options: SerializeSimplifiedNodeOptions,
): string[] {
	const lines: string[] = [];
	const childIndent = "  ".repeat(baseDepth);
	let i = 0;

	while (i < children.length) {
		const c = children[i];
		if (isTextOnlyLeaf(c)) {
			const textItems: string[] = [c.text];
			const mergedChildren: SimplifiedNode[] = [c];
			let j = i + 1;
			while (
				j < children.length &&
				canMergeTextOnlyLeaves(c, children[j])
			) {
				textItems.push(children[j].text);
				mergedChildren.push(children[j]);
				j++;
			}
			if (textItems.length > 1) {
				const mergedNoClick = mergedChildren.some(
					(m) => m.noClickAllowed,
				);
				const combinedNode: SimplifiedNode = {
					...c,
					text: textItems.join(", "),
					...(mergedNoClick ? { noClickAllowed: true } : {}),
				};
				const mergedBid = mergeBidValues(mergedChildren);
				if (mergedBid) {
					const bidIdx = combinedNode.attrs.findIndex(
						([name]) => name === "bid",
					);
					if (bidIdx >= 0) {
						combinedNode.attrs[bidIdx][1] = mergedBid;
					} else {
						combinedNode.attrs.unshift(["bid", mergedBid]);
					}
				}
				const combinedHead = formatSerializedHead(
					combinedNode,
					baseDepth,
					{
						omitHrefs: options.omitHrefs,
						preserveFullHrefs: options.preserveFullHrefs,
						suppressCouldBeHiddenMarker: couldBeHiddenCtx,
					},
				);
				const combinedText = quoteYamlText(combinedNode.text);
				lines.push(
					combinedHead.trim()
						? `${combinedHead}: ${combinedText}`
						: `${childIndent}${combinedText}`,
				);
			} else {
				lines.push(
					serializeSimplifiedNode(
						c,
						baseDepth,
						hiddenCtx,
						couldBeHiddenCtx,
						options,
					),
				);
			}
			i = j;
		} else {
			lines.push(
				serializeSimplifiedNode(
					c,
					baseDepth,
					hiddenCtx,
					couldBeHiddenCtx,
					options,
				),
			);
			i++;
		}
	}

	return lines;
}

export function serializeSimplifiedNode(
	node: SimplifiedNode,
	depth: number,
	inHiddenContext = false,
	inCouldBeHiddenContext = false,
	options: SerializeSimplifiedNodeOptions = {},
): string {
	const indent = "  ".repeat(depth);
	if (node.outsideViewport) {
		const bid = getAttrValue(node.attrs, "bid");
		if (!bid) {
			throw new Error("Outside-viewport placeholders require a bid");
		}
		return `${indent}content-hidden-outside-viewport bid="${bid}" scroll-delta-y="${node.outsideViewport.scrollDeltaY}"`;
	}
	if (node.couldBeHidden && !inCouldBeHiddenContext) {
		return [
			`${indent}couldBeHidden`,
			serializeSimplifiedNode(
				node,
				depth + 1,
				inHiddenContext,
				true,
				options,
			),
		].join("\n");
	}

	const anchorOutline = buildAnchorOutlineReformat(node);
	if (anchorOutline) {
		const head = formatSerializedHead(anchorOutline.headNode, depth, {
			forceTagName: true,
			omitHrefs: options.omitHrefs,
			preserveFullHrefs: options.preserveFullHrefs,
			suppressCouldBeHiddenMarker: inCouldBeHiddenContext,
		});
		const lines: string[] = [`${head}:`];
		const groupIndent = "  ".repeat(depth + 1);
		const valueIndent = "  ".repeat(depth + 2);
		for (const item of anchorOutline.items) {
			lines.push(`${groupIndent}- ${quoteYamlText(item.label)}:`);
			for (const value of item.values) {
				lines.push(`${valueIndent}- ${quoteYamlText(value)}`);
			}
		}
		return lines.join("\n");
	}

	const head = formatSerializedHead(node, depth, {
		omitHrefs: options.omitHrefs,
		preserveFullHrefs: options.preserveFullHrefs,
		suppressCouldBeHiddenMarker: inCouldBeHiddenContext,
	});
	const quotedText = node.text ? quoteYamlText(node.text) : "";

	if (node.children.length === 0) {
		if (node.text) {
			return head.trim()
				? `${head}: ${quotedText}`
				: `${indent}${quotedText}`;
		}
		return head;
	}

	const lines: string[] = [];

	if (inHiddenContext) {
		// Already in hidden context - serialize all children normally without separating
		lines.push(
			...serializeChildren(
				node.children,
				depth + 1,
				true,
				inCouldBeHiddenContext,
				options,
			),
		);
	} else {
		// Separate hidden and visible children
		const hiddenChildren = node.children.filter((c) => c.isHidden);
		const visibleChildren = node.children.filter((c) => !c.isHidden);

		// Serialize visible children
		lines.push(
			...serializeChildren(
				visibleChildren,
				depth + 1,
				false,
				inCouldBeHiddenContext,
				options,
			),
		);

		// Group hidden children under a "hidden:" wrapper
		if (hiddenChildren.length > 0) {
			lines.push(`${indent}  hidden:`);
			lines.push(
				...serializeChildren(
					hiddenChildren,
					depth + 2,
					true,
					inCouldBeHiddenContext,
					options,
				),
			);
		}
	}

	const childLines = lines.join("\n");
	if (node.text) {
		return head.trim()
			? `${head}: ${quotedText}\n${childLines}`
			: `${indent}${quotedText}\n${childLines}`;
	}
	return head.trim()
		? `${head}:\n${childLines}`
		: `${indent}:\n${childLines}`;
}
