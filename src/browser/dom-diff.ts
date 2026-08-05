/**
 * Compute a minimal line-level diff between two simplified DOM snapshots.
 * Output uses a compact format:
 *   lines prefixed with "- " were removed, "+ " were added, " " unchanged (context).
 * Only changed regions with 2 lines of surrounding context are included.
 */
export function computeDomDiff(prev: string, curr: string): string {
	const a = prev.split("\n");
	const b = curr.split("\n");

	// Simple LCS-based diff
	const m = a.length;
	const n = b.length;

	// For large DOMs, fall back to a line-set heuristic to avoid O(m*n) memory
	if (m * n > 2_000_000) {
		return fastDiff(a, b);
	}

	// Standard DP LCS
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array(n + 1).fill(0),
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1] + 1
					: Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}

	// Backtrack to produce edit script
	const ops: { type: "keep" | "del" | "add"; line: string }[] = [];
	let i = m,
		j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
			ops.push({ type: "keep", line: a[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			ops.push({ type: "add", line: b[j - 1] });
			j--;
		} else {
			ops.push({ type: "del", line: a[i - 1] });
			i--;
		}
	}
	ops.reverse();

	return formatHunks(ops);
}

/** Fast diff for large DOMs: match identical lines, show changed blocks */
function fastDiff(a: string[], b: string[]): string {
	const ops: { type: "keep" | "del" | "add"; line: string }[] = [];
	let i = 0,
		j = 0;

	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			ops.push({ type: "keep", line: a[i] });
			i++;
			j++;
		} else {
			// Scan ahead in b for a[i]
			let foundInB = -1;
			for (let k = j + 1; k < Math.min(j + 30, b.length); k++) {
				if (b[k] === a[i]) {
					foundInB = k;
					break;
				}
			}
			// Scan ahead in a for b[j]
			let foundInA = -1;
			for (let k = i + 1; k < Math.min(i + 30, a.length); k++) {
				if (a[k] === b[j]) {
					foundInA = k;
					break;
				}
			}

			if (
				foundInB !== -1 &&
				(foundInA === -1 || foundInB - j <= foundInA - i)
			) {
				while (j < foundInB) {
					ops.push({ type: "add", line: b[j] });
					j++;
				}
			} else if (foundInA !== -1) {
				while (i < foundInA) {
					ops.push({ type: "del", line: a[i] });
					i++;
				}
			} else {
				ops.push({ type: "del", line: a[i] });
				i++;
				ops.push({ type: "add", line: b[j] });
				j++;
			}
		}
	}
	while (i < a.length) {
		ops.push({ type: "del", line: a[i] });
		i++;
	}
	while (j < b.length) {
		ops.push({ type: "add", line: b[j] });
		j++;
	}

	return formatHunks(ops);
}

/** Extract changed hunks with 2 lines of context */
function formatHunks(
	ops: { type: "keep" | "del" | "add"; line: string }[],
): string {
	const CONTEXT = 2;
	// Find indices of changed lines
	const changed = new Set<number>();
	for (let i = 0; i < ops.length; i++) {
		if (ops[i].type !== "keep") {
			for (
				let c = Math.max(0, i - CONTEXT);
				c <= Math.min(ops.length - 1, i + CONTEXT);
				c++
			) {
				changed.add(c);
			}
		}
	}

	if (changed.size === 0) return "";

	const lines: string[] = [];
	let inHunk = false;
	for (let i = 0; i < ops.length; i++) {
		if (!changed.has(i)) {
			if (inHunk) {
				lines.push("...");
				inHunk = false;
			}
			continue;
		}
		inHunk = true;
		const prefix =
			ops[i].type === "keep" ? "  " : ops[i].type === "del" ? "- " : "+ ";
		lines.push(prefix + ops[i].line);
	}

	return lines.join("\n");
}
