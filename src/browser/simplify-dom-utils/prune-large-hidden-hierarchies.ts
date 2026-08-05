function getIndentDepth(line: string): number {
	const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
	return Math.floor(leadingSpaces / 2);
}

/**
 * Post-process serialized simplified DOM and prune children under any
 * "hidden:" hierarchy whose full block takes more than maxRatio of total chars.
 */
export function pruneLargeHiddenHierarchies(
	simplifiedDom: string,
	maxRatio: number = 0.001,
	removeEntireHiddenHierarchyWithoutBid: boolean = false,
): string {
	if (!simplifiedDom.trim()) return simplifiedDom;
	const lines = simplifiedDom.split("\n");
	if (lines.length === 0) return simplifiedDom;

	const totalChars = simplifiedDom.length;
	if (totalChars === 0) return simplifiedDom;
	const removeLineIndices = new Set<number>();

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() !== "hidden:") continue;

		const hiddenDepth = getIndentDepth(lines[i]);
		let end = i + 1;
		while (end < lines.length) {
			const trimmed = lines[end].trim();
			if (!trimmed) {
				end++;
				continue;
			}
			if (getIndentDepth(lines[end]) <= hiddenDepth) break;
			end++;
		}

		const hasBid = lines
			.slice(i + 1, end)
			.some((line) => line.includes(`bid="`));
		if (removeEntireHiddenHierarchyWithoutBid && !hasBid) {
			for (let j = i; j < end; j++) {
				removeLineIndices.add(j);
			}
			continue;
		}

		const hierarchyChars = lines.slice(i, end).join("\n").length;
		if (hierarchyChars <= 10 || hierarchyChars / totalChars <= maxRatio)
			continue;

		for (let j = i + 1; j < end; j++) {
			removeLineIndices.add(j);
		}
	}

	if (removeLineIndices.size === 0) return simplifiedDom;
	return lines.filter((_, idx) => !removeLineIndices.has(idx)).join("\n");
}
