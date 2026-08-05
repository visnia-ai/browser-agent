import { normalizeComparableText } from "./text-normalization.js";

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

function upsertAttr(
	attrs: [string, string][],
	name: string,
	value: string,
): [string, string][] {
	const idx = getAttrIndex(attrs, name);
	if (idx >= 0) {
		attrs[idx][1] = value;
		return attrs;
	}
	attrs.push([name, value]);
	return attrs;
}

export function normalizeAriaLabelIntoText(
	tag: string,
	attrs: [string, string][],
	text: string,
): {
	attrs: [string, string][];
	text: string;
} {
	const ariaLabel = getAttrValue(attrs, "aria-label");
	const normalizedAria = normalizeComparableText(ariaLabel);
	const placeholder = getAttrValue(attrs, "placeholder");
	const normalizedPlaceholder = normalizeComparableText(placeholder);
	const normalizedText = normalizeComparableText(text);

	// Rule 3: aria-label and placeholder overlap => keep longer placeholder, drop aria-label.
	if (normalizedAria && normalizedPlaceholder) {
		const overlaps =
			normalizedAria.includes(normalizedPlaceholder) ||
			normalizedPlaceholder.includes(normalizedAria);
		if (overlaps) {
			const ariaValue = ariaLabel!.trim();
			const placeholderValue = placeholder!.trim();
			const longest =
				ariaValue.length >= placeholderValue.length
					? ariaValue
					: placeholderValue;
			attrs = removeAttr(attrs, "aria-label");
			attrs = upsertAttr(attrs, "placeholder", longest);
		}
	}

	// Rule 1: aria-label exists and text is empty => move aria-label into text.
	if (normalizedAria && !normalizedText) {
		text = ariaLabel!.trim();
		attrs = removeAttr(attrs, "aria-label");
	}
	// Rule 2: both exist and one contains the other => keep only longer as text.
	else if (normalizedAria && normalizedText) {
		const overlaps =
			normalizedAria.includes(normalizedText) ||
			normalizedText.includes(normalizedAria);
		if (overlaps) {
			const ariaValue = ariaLabel!.trim();
			const textValue = text.trim();
			text =
				ariaValue.length >= textValue.length
					? ariaValue
					: textValue;
			attrs = removeAttr(attrs, "aria-label");
		}
	}

	// Rule 4: input value attribute equals node text => drop value attr, keep text.
	if (tag === "INPUT") {
		const valueAttr = getAttrValue(attrs, "value");
		if (valueAttr !== undefined && valueAttr === text) {
			attrs = removeAttr(attrs, "value");
		}
	}

	return { attrs, text };
}
