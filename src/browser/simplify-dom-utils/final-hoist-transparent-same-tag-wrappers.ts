import type { SimplifiedNode } from "./simplified-node.js";

function hasNoSemanticAttrs(node: SimplifiedNode): boolean {
	return node.attrs.every(([name]) => name === "ncid");
}

function isTransparentSameTagWrapper(
	parent: SimplifiedNode,
	child: SimplifiedNode,
): boolean {
	return (
		child.tag === parent.tag &&
		!child.isInteractive &&
		child.isHidden === parent.isHidden &&
		Boolean(child.couldBeHidden) === Boolean(parent.couldBeHidden) &&
		!child.text &&
		hasNoSemanticAttrs(child) &&
		child.children.length > 0
	);
}

export function runFinalTransparentWrapperHoist(
	node: SimplifiedNode,
): SimplifiedNode {
	node.children = node.children.map(runFinalTransparentWrapperHoist);

	const hoistedChildren: SimplifiedNode[] = [];
	const appendChild = (child: SimplifiedNode): void => {
		if (isTransparentSameTagWrapper(node, child)) {
			for (const grandChild of child.children) appendChild(grandChild);
			return;
		}
		hoistedChildren.push(child);
	};
	for (const child of node.children) appendChild(child);
	node.children = hoistedChildren;

	if (hasNoSemanticAttrs(node) && !node.text && node.children.length === 1) {
		return node.children[0];
	}

	return node;
}
