const DEFAULT_CONTEXT_LINES = 3;
const MAX_EXACT_DIFF_CELL_COUNT = 1_000_000;

type DiffOp =
	| { type: "equal"; line: string }
	| { type: "delete"; line: string }
	| { type: "insert"; line: string };

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function buildReplacementDiff(
	baseLines: string[],
	currentLines: string[],
): DiffOp[] {
	return [
		...baseLines.map((line): DiffOp => ({ type: "delete", line })),
		...currentLines.map((line): DiffOp => ({ type: "insert", line })),
	];
}

function buildExactDiff(baseLines: string[], currentLines: string[]): DiffOp[] {
	const rows = baseLines.length + 1;
	const cols = currentLines.length + 1;
	const table: number[][] = Array.from({ length: rows }, () =>
		Array<number>(cols).fill(0),
	);

	for (let i = baseLines.length - 1; i >= 0; i--) {
		for (let j = currentLines.length - 1; j >= 0; j--) {
			table[i][j] =
				baseLines[i] === currentLines[j]
					? table[i + 1][j + 1] + 1
					: Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}

	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < baseLines.length && j < currentLines.length) {
		if (baseLines[i] === currentLines[j]) {
			ops.push({ type: "equal", line: baseLines[i] });
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			ops.push({ type: "delete", line: baseLines[i] });
			i++;
		} else {
			ops.push({ type: "insert", line: currentLines[j] });
			j++;
		}
	}
	while (i < baseLines.length) {
		ops.push({ type: "delete", line: baseLines[i] });
		i++;
	}
	while (j < currentLines.length) {
		ops.push({ type: "insert", line: currentLines[j] });
		j++;
	}
	return ops;
}

function addHunk(
	output: string[],
	ops: DiffOp[],
	start: number,
	end: number,
): void {
	let oldStart = 0;
	let oldCount = 0;
	let newStart = 0;
	let newCount = 0;
	let oldLine = 1;
	let newLine = 1;

	for (let i = 0; i < ops.length; i++) {
		if (i === start) {
			oldStart = oldLine;
			newStart = newLine;
		}
		const op = ops[i];
		if (i >= start && i < end) {
			if (op.type !== "insert") oldCount++;
			if (op.type !== "delete") newCount++;
		}
		if (op.type !== "insert") oldLine++;
		if (op.type !== "delete") newLine++;
	}

	output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
	for (const op of ops.slice(start, end)) {
		const prefix =
			op.type === "insert" ? "+" : op.type === "delete" ? "-" : " ";
		output.push(`${prefix}${op.line}`);
	}
}

function formatUnifiedDiff(ops: DiffOp[], contextLines: number): string {
	const output = ["--- previous-projection", "+++ current-projection"];
	let index = 0;
	while (index < ops.length) {
		while (index < ops.length && ops[index].type === "equal") index++;
		if (index >= ops.length) break;

		const start = Math.max(0, index - contextLines);
		while (index < ops.length) {
			let equalCount = 0;
			while (
				index + equalCount < ops.length &&
				ops[index + equalCount].type === "equal"
			) {
				equalCount++;
			}
			if (equalCount > contextLines * 2) break;
			index += Math.max(1, equalCount);
		}
		const end = Math.min(ops.length, index + contextLines);
		addHunk(output, ops, start, end);
	}
	return output.join("\n");
}

export function buildProjectionUnifiedDiff(
	baseProjection: string,
	currentProjection: string,
): string | null {
	if (
		!baseProjection ||
		!currentProjection ||
		baseProjection === currentProjection
	) {
		return null;
	}

	const baseLines = splitLines(baseProjection);
	const currentLines = splitLines(currentProjection);
	let prefixLength = 0;
	while (
		prefixLength < baseLines.length &&
		prefixLength < currentLines.length &&
		baseLines[prefixLength] === currentLines[prefixLength]
	) {
		prefixLength++;
	}

	let suffixLength = 0;
	while (
		suffixLength < baseLines.length - prefixLength &&
		suffixLength < currentLines.length - prefixLength &&
		baseLines[baseLines.length - 1 - suffixLength] ===
			currentLines[currentLines.length - 1 - suffixLength]
	) {
		suffixLength++;
	}

	const baseMiddle = baseLines.slice(
		prefixLength,
		baseLines.length - suffixLength,
	);
	const currentMiddle = currentLines.slice(
		prefixLength,
		currentLines.length - suffixLength,
	);
	const exactDiffCellCount = baseMiddle.length * currentMiddle.length;
	const middleOps =
		exactDiffCellCount <= MAX_EXACT_DIFF_CELL_COUNT
			? buildExactDiff(baseMiddle, currentMiddle)
			: buildReplacementDiff(baseMiddle, currentMiddle);

	const ops: DiffOp[] = [
		...baseLines
			.slice(0, prefixLength)
			.map((line): DiffOp => ({ type: "equal", line })),
		...middleOps,
		...baseLines
			.slice(baseLines.length - suffixLength)
			.map((line): DiffOp => ({ type: "equal", line })),
	];
	return formatUnifiedDiff(ops, DEFAULT_CONTEXT_LINES);
}

export type ProjectionHistoryContext =
	| {
			mode: "full";
			projection: string;
			diffLength: number | null;
	  }
	| {
			mode: "diff";
			projection: string;
			diffLength: number;
	  };

export function resolveProjectionHistoryContext(params: {
	previousProjection?: string;
	currentProjection: string;
	maxDiffToFullRatio?: number;
}): ProjectionHistoryContext {
	const maxDiffToFullRatio = params.maxDiffToFullRatio ?? 0.5;
	if (
		typeof params.previousProjection !== "string" ||
		params.previousProjection.length === 0
	) {
		return {
			mode: "full",
			projection: params.currentProjection,
			diffLength: null,
		};
	}
	if (params.previousProjection === params.currentProjection) {
		return { mode: "diff", projection: "", diffLength: 0 };
	}

	const diff = buildProjectionUnifiedDiff(
		params.previousProjection,
		params.currentProjection,
	);
	if (
		diff === null ||
		params.currentProjection.length === 0 ||
		diff.length > params.currentProjection.length * maxDiffToFullRatio
	) {
		return {
			mode: "full",
			projection: params.currentProjection,
			diffLength: diff?.length ?? null,
		};
	}
	return { mode: "diff", projection: diff, diffLength: diff.length };
}
