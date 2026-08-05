import { normalizeComparableText } from "./text-normalization.js";
import type { SimplifiedNode } from "./simplified-node.js";

function isTextOnlyChild(node: SimplifiedNode): boolean {
	return (
		node.attrs.length === 0 &&
		node.children.length === 0 &&
		!!node.text &&
		!node.isInteractive &&
		(node.tag === "div" || node.tag === "span" || node.tag === "")
	);
}

function isSubsetText(parentText: string, childText: string): boolean {
	const normalizedParent = normalizeComparableText(parentText);
	const normalizedChild = normalizeComparableText(childText);
	if (!normalizedParent || !normalizedChild) return false;
	return normalizedParent.includes(normalizedChild);
}

export function removeRedundantSingleTextChild(
	node: SimplifiedNode,
): SimplifiedNode {
	node.children = node.children.map(removeRedundantSingleTextChild);

	if (!node.text || node.children.length !== 1) return node;

	const child = node.children[0];
	if (!isTextOnlyChild(child)) return node;
	if (!isSubsetText(node.text, child.text)) return node;

	node.children = [];
	return node;
}
