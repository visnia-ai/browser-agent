/** Extract unique bid values from visible nodes in serialized DOM snapshot. */
export function extractValidBids(dom: string): string[] {
	const seen = new Set<string>();
	const bids: string[] = [];

	const lines = dom.split("\n");
	const hiddenDepthStack: number[] = [];
	const bidRegex = /\bbid="([^"]+)"/g;

	for (const line of lines) {
		if (!line.trim()) continue;
		const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
		const depth = Math.floor(leadingSpaces / 2);
		const trimmed = line.trim();

		// Drop hidden wrappers that no longer contain this depth.
		while (
			hiddenDepthStack.length > 0 &&
			hiddenDepthStack[hiddenDepthStack.length - 1] >= depth
		) {
			hiddenDepthStack.pop();
		}

		// "hidden:" marks a subtree that should be ignored for visible interactions.
		if (trimmed === "hidden:") {
			hiddenDepthStack.push(depth);
			continue;
		}
		if (hiddenDepthStack.length > 0) continue;

		let match: RegExpExecArray | null;
		while ((match = bidRegex.exec(trimmed)) !== null) {
			const bid = match[1]?.trim();
			if (!bid || seen.has(bid)) continue;
			seen.add(bid);
			bids.push(bid);
		}
	}

	return bids;
}
