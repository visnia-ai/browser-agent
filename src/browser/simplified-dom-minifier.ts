const INDENT_WIDTH = 2;

interface SimplifiedDomLine {
	depth: number;
	content: string;
}

function parseSimplifiedDomLines(simplifiedDom: string): SimplifiedDomLine[] {
	return simplifiedDom
		.split("\n")
		.map((line) => {
			if (!line.trim()) return null;
			const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
			const depth = Math.floor(leadingSpaces / INDENT_WIDTH);
			const content = line.slice(depth * INDENT_WIDTH);
			return {
				depth,
				content,
			};
		})
		.filter((line): line is SimplifiedDomLine => line !== null);
}

function escapeContent(content: string): string {
	return content
		.replaceAll("\\", "\\\\")
		.replaceAll("<", "\\<")
		.replaceAll(">", "\\>")
		.replaceAll("^", "\\^");
}

function unescapeContent(content: string): string {
	let out = "";
	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		if (i + 1 < content.length) {
			out += content[i + 1];
			i++;
			continue;
		}
		out += "\\";
	}
	return out;
}

/** Convert indented simplified DOM into compact single-line bracket notation. */
export function minifySimplifiedDOM(simplifiedDom: string): string {
	const lines = parseSimplifiedDomLines(simplifiedDom);
	if (lines.length === 0) return "";

	let result = "";

	for (let i = 0; i < lines.length; i++) {
		const current = lines[i];
		const nextDepth = i < lines.length - 1 ? lines[i + 1].depth : 0;
		let encodedContent = escapeContent(current.content);
		if (i > 0) {
			const prevDepth = lines[i - 1].depth;
			const inferredNextDepth = prevDepth + 1;
			const extraDepth = current.depth - inferredNextDepth;
			if (extraDepth > 0) {
				encodedContent = `^${extraDepth}|${encodedContent}`;
			}
		}

		if (result) result += " ";
		result += `<${encodedContent}`;

		if (nextDepth <= current.depth) {
			const closeCount = 1 + (current.depth - nextDepth);
			result += ">".repeat(closeCount);
		}
	}

	// Keep a terminal sentinel close to match the compact format convention.
	result += ">";

	return result;
}

/** Convert compact bracket notation back into indented simplified DOM text. */
export function unminifySimplifiedDOM(minifiedDom: string): string {
	const source = minifiedDom.trim();
	if (!source) return "";

	const lines: string[] = [];
	let depth = 0;
	let i = 0;

	while (i < source.length) {
		const char = source[i];

		if (char.trim() === "") {
			i++;
			continue;
		}

		if (char === ">") {
			let closeCount = 0;
			while (i < source.length && source[i] === ">") {
				closeCount++;
				i++;
			}
			depth = Math.max(0, depth - closeCount);
			continue;
		}

		if (char === "<") {
			i++;
			let encodedContent = "";
			while (i < source.length) {
				const tokenChar = source[i];
				if (tokenChar === "\\") {
					if (i + 1 < source.length) {
						encodedContent += source[i] + source[i + 1];
						i += 2;
						continue;
					}
					encodedContent += "\\";
					i++;
					continue;
				}
				if (tokenChar === "<" || tokenChar === ">") break;
				encodedContent += tokenChar;
				i++;
			}
			let content = unescapeContent(encodedContent).trimEnd();
			const depthMatch = content.match(/^\^(\d+)\|(.*)$/s);
			if (depthMatch) {
				const jump = Number.parseInt(depthMatch[1], 10);
				if (!Number.isNaN(jump) && jump > 0) {
					depth += jump;
				}
				content = depthMatch[2];
			}
			if (!content) continue;
			lines.push(`${" ".repeat(depth * INDENT_WIDTH)}${content}`);
			depth++;
			continue;
		}

		i++;
	}

	return lines.join("\n");
}
