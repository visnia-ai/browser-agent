const INDENT_WIDTH = 2;

function requestedRoots(value: string): string[] {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error("extract_data requires a non-empty root");
	}
	const refs = value.split(",").map((ref) => ref.trim());
	if (refs.length === 0 || refs.some((ref) => !ref)) {
		throw new Error(
			"extract_data root must contain non-empty comma-separated refs",
		);
	}
	return refs;
}

function lineRef(line: string): string | undefined {
	return /\bref="([^"]+)"/.exec(line)?.[1];
}

function lineDepth(line: string): number {
	return Math.floor((line.match(/^ */)?.[0].length ?? 0) / INDENT_WIDTH);
}

function subtreeEnd(lines: string[], start: number): number {
	const depth = lineDepth(lines[start] ?? "");
	let end = start + 1;
	while (end < lines.length) {
		if (lines[end]?.trim() && lineDepth(lines[end]!) <= depth) break;
		end++;
	}
	return end;
}

function normalizeRegion(lines: string[]): string {
	while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
	while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
	const indentation = lines
		.filter((line) => line.trim())
		.reduce(
			(minimum, line) =>
				Math.min(minimum, line.match(/^ */)?.[0].length ?? 0),
			Number.POSITIVE_INFINITY,
		);
	return lines
		.map((line) =>
			line
				.slice(Number.isFinite(indentation) ? indentation : 0)
				.trimEnd(),
		)
		.join("\n")
		.trim();
}

export interface ExtractSemanticProjectionRegionInput {
	projection: string;
	root: string;
}

export function extractSemanticProjectionRegion(
	input: ExtractSemanticProjectionRegionInput,
): string {
	const lines = input.projection.split("\n");
	const starts = requestedRoots(input.root).map((ref) => {
		const start = lines.findIndex((line) => lineRef(line) === ref);
		if (start < 0) {
			throw new Error(
				`extract_data root=${ref}: target not found in semantic projection`,
			);
		}
		return start;
	});
	const regions = [...new Set(starts)]
		.sort((left, right) => left - right)
		.map((start) => ({ start, end: subtreeEnd(lines, start) }));
	const roots = regions.filter(
		(region, index) =>
			!regions
				.slice(0, index)
				.some(
					(ancestor) =>
						ancestor.start <= region.start &&
						ancestor.end >= region.end,
				),
	);

	return roots
		.map(({ start, end }) => normalizeRegion(lines.slice(start, end)))
		.join("\n");
}
