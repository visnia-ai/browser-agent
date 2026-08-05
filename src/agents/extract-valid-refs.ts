/** Extract the unique opaque refs exposed by a semantic page projection. */
export function extractValidRefs(projection: string): string[] {
	const refs: string[] = [];
	const seen = new Set<string>();
	for (const match of projection.matchAll(/\bref="([^"]+)"/g)) {
		const ref = match[1]?.trim();
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		refs.push(ref);
	}
	return refs;
}
