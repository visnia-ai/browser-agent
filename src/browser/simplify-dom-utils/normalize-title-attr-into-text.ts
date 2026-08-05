import { normalizeComparableText } from "./text-normalization.js";
import type { SimplifiedNode } from "./simplified-node.js";

interface IndexedAttr {
	index: number;
	name: string;
	value: string;
}

function getTitleAttrs(attrs: [string, string][]): IndexedAttr[] {
	const titles: IndexedAttr[] = [];
	for (let i = 0; i < attrs.length; i++) {
		const [name, value] = attrs[i];
		if (name !== "title") continue;
		titles.push({ index: i, name, value });
	}
	return titles;
}

function chooseOverlappingTitle(
	titles: IndexedAttr[],
	normalizedText: string,
): IndexedAttr | null {
	let selected: IndexedAttr | null = null;
	for (const titleAttr of titles) {
		const normalizedTitle = normalizeComparableText(titleAttr.value);
		if (!normalizedTitle) continue;
		const overlaps =
			normalizedTitle.includes(normalizedText) ||
			normalizedText.includes(normalizedTitle);
		if (!overlaps) continue;
		if (!selected || titleAttr.value.trim().length > selected.value.trim().length) {
			selected = titleAttr;
		}
	}
	return selected;
}

export function normalizeTitleAttrIntoText(node: SimplifiedNode): SimplifiedNode {
	node.children = node.children.map(normalizeTitleAttrIntoText);

	const normalizedText = normalizeComparableText(node.text);
	if (!normalizedText) return node;

	const titleAttrs = getTitleAttrs(node.attrs);
	if (titleAttrs.length === 0) return node;

	const overlappingTitle = chooseOverlappingTitle(titleAttrs, normalizedText);
	if (!overlappingTitle) return node;

	const normalizedTextValue = node.text.trim();
	const normalizedTitleValue = overlappingTitle.value.trim();
	node.text =
		normalizedTitleValue.length >= normalizedTextValue.length
			? normalizedTitleValue
			: normalizedTextValue;

	if (titleAttrs.length === 1) {
		node.attrs = node.attrs.filter(([name]) => name !== "title");
		return node;
	}

	node.attrs = node.attrs.filter((_, index) => index !== overlappingTitle.index);
	return node;
}
