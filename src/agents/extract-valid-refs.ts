/** Extract unique opaque refs exposed by a semantic projection or Markdown ref footer. */
export function extractValidRefs(projection: string): string[] {
	const refs: string[] = [];
	const seen = new Set<string>();
	for (const match of projection.matchAll(/(?:\bref="([^"]+)"|\[(r[0-9a-z]+)\])/g)) {
		const ref = (match[1] ?? match[2])?.trim();
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		refs.push(ref);
	}
	return refs;
}
