import type { SimplifiedNode } from "./simplified-node.js";

function hasSemanticInformation(node: SimplifiedNode): boolean {
	if (node.text.trim().length > 0) return true;
	if (node.attrs.some(([name]) => name !== "bid" && name !== "ncid")) {
		return true;
	}
	return Boolean(
		node.outsideViewport || node.scrollEnabled || node.scrollable,
	);
}

/**
 * Remove branches whose nodes contain only structural tags and bid/ncid handles.
 * Ancestors are retained whenever at least one descendant is semantically useful.
 */
export function discardEmptyBidHierarchies(
	node: SimplifiedNode,
): SimplifiedNode | null {
	const retainedChildren: SimplifiedNode[] = [];
	for (const child of node.children) {
		const retainedChild = discardEmptyBidHierarchies(child);
		if (retainedChild) retainedChildren.push(retainedChild);
	}
	node.children = retainedChildren;

	return hasSemanticInformation(node) || retainedChildren.length > 0
		? node
		: null;
}
