export function normalizeLabel(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value.trim().replace(/\s+/g, " ");
	return normalized || undefined;
}

export function normalizeComparableText(
	value: string | undefined,
): string | undefined {
	const normalized = normalizeLabel(value);
	return normalized ? normalized.toLowerCase() : undefined;
}
