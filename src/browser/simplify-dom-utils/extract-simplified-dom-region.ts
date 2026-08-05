const INDENT_WIDTH = 2;

function identifierCandidates(value: string): string[] {
	return value
		.split(",")
		.map((candidate) => candidate.trim())
		.filter(Boolean);
}

function requestedRootIdentifiers(value: string): string[] {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error("extract_data requires a non-empty root");
	}
	const identifiers = value.split(",").map((identifier) => identifier.trim());
	if (
		identifiers.length === 0 ||
		identifiers.some((identifier) => !identifier)
	) {
		throw new Error(
			"extract_data root must contain non-empty comma-separated identifiers",
		);
	}
	return identifiers;
}

function lineIdentifiers(line: string): string[] {
	const identifiers: string[] = [];
	const attributePattern = /\b(?:bid|ncid)="([^"]+)"/g;
	let match: RegExpExecArray | null;
	while ((match = attributePattern.exec(line)) !== null) {
		identifiers.push(...identifierCandidates(match[1] ?? ""));
	}
	return identifiers;
}

function findIdentifierLine(lines: string[], identifier: string): number {
	return lines.findIndex((line) =>
		lineIdentifiers(line).includes(identifier),
	);
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

function stripIdentifiers(line: string): string {
	const indentation = line.match(/^ */)?.[0] ?? "";
	const content = line
		.slice(indentation.length)
		.replace(/(^|\s)(?:bid|ncid)="[^"]*"/g, "$1")
		.replace(/^\s*:\s*/, "")
		.replace(/\s+:/g, ":")
		.replace(/^(\S+)\s{2,}/, "$1 ")
		.trim();
	return content ? `${indentation}${content}` : "";
}

function stripIdentifierOnlyNodes(lines: string[]): string[] {
	const removedDepths: number[] = [];
	const result: string[] = [];
	for (const line of lines) {
		if (!line.trim()) {
			result.push("");
			continue;
		}
		const depth = lineDepth(line);
		while (removedDepths.length > 0 && removedDepths.at(-1)! >= depth) {
			removedDepths.pop();
		}
		const stripped = stripIdentifiers(line);
		if (!stripped.trim()) {
			removedDepths.push(depth);
			continue;
		}
		result.push(stripped.slice(removedDepths.length * INDENT_WIDTH));
	}
	return result;
}

function normalizeRegion(lines: string[]): string {
	lines = stripIdentifierOnlyNodes(lines);
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

export interface ExtractSimplifiedDomRegionInput {
	simplifiedDom: string;
	root: string;
}

export function extractSimplifiedDomRegion(
	input: ExtractSimplifiedDomRegionInput,
): string {
	const lines = input.simplifiedDom.split("\n");
	const starts = requestedRootIdentifiers(input.root).map((identifier) => {
		const start = findIdentifierLine(lines, identifier);
		if (start < 0) {
			throw new Error(
				`extract_data root=${identifier}: target not found in simplified DOM`,
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
