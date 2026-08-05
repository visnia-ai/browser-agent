import { normalizeLabel } from "./text-normalization.js";
import type { SimplifiedNode } from "./simplified-node.js";

function getAttrIndex(attrs: [string, string][], name: string): number {
	return attrs.findIndex(([k]) => k === name);
}

function getAttrValue(
	attrs: [string, string][],
	name: string,
): string | undefined {
	const idx = getAttrIndex(attrs, name);
	if (idx < 0) return undefined;
	return attrs[idx][1];
}

function removeAttr(
	attrs: [string, string][],
	name: string,
): [string, string][] {
	return attrs.filter(([k]) => k !== name);
}

export function collapseRedundantDivLabelChildren(
	node: SimplifiedNode,
): SimplifiedNode {
	node.children = node.children.map(collapseRedundantDivLabelChildren);

	if (node.tag !== "div") return node;

	const parentAria = normalizeLabel(getAttrValue(node.attrs, "aria-label"));
	const parentText = normalizeLabel(node.text);
	const parentLabels = new Set<string>();
	if (parentAria) parentLabels.add(parentAria);
	if (parentText) parentLabels.add(parentText);
	if (parentLabels.size === 0) return node;

	const prunedChildren: SimplifiedNode[] = [];
	for (const child of node.children) {
		const childAria = normalizeLabel(
			getAttrValue(child.attrs, "aria-label"),
		);
		if (childAria && parentLabels.has(childAria)) {
			child.attrs = removeAttr(child.attrs, "aria-label");
		}

		const childText = normalizeLabel(child.text);
		if (childText && parentLabels.has(childText)) {
			child.text = "";
		}

		const isEmptyLeaf =
			child.attrs.length === 0 &&
			!child.text &&
			child.children.length === 0;
		if (isEmptyLeaf) continue;

		prunedChildren.push(child);
	}
	node.children = prunedChildren;
	return node;
}
