import { readFile } from "node:fs/promises";

type CsvDelimiter = "," | ";" | "\t";

function countDelimiter(text: string, delimiter: CsvDelimiter): number {
	let count = 0;
	let inQuotes = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const nextChar = text[index + 1];
		if (char === '"') {
			if (inQuotes && nextChar === '"') {
				index += 1;
				continue;
			}
			inQuotes = !inQuotes;
		} else if (!inQuotes && char === delimiter) {
			count += 1;
		}
	}
	return count;
}

function detectDelimiter(text: string): CsvDelimiter {
	const sample = text.slice(0, 4096);
	const commaCount = countDelimiter(sample, ",");
	const semicolonCount = countDelimiter(sample, ";");
	const tabCount = countDelimiter(sample, "\t");
	if (tabCount >= commaCount && tabCount >= semicolonCount) return "\t";
	return semicolonCount > commaCount ? ";" : ",";
}

export function parseCsvContent(contents: string): string[][] {
	const text = contents.replace(/^\uFEFF/, "");
	if (!text.trim()) return [];

	const delimiter = detectDelimiter(text);
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let inQuotes = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const nextChar = text[index + 1];
		if (char === '"') {
			if (inQuotes && nextChar === '"') {
				cell += '"';
				index += 1;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (!inQuotes && char === delimiter) {
			row.push(cell);
			cell = "";
		} else if (!inQuotes && (char === "\n" || char === "\r")) {
			row.push(cell);
			cell = "";
			if (row.length > 1 || row[0]?.length) rows.push(row);
			row = [];
			if (char === "\r" && nextChar === "\n") index += 1;
		} else {
			cell += char;
		}
	}

	row.push(cell);
	if (row.length > 1 || row[0]?.length) rows.push(row);
	return rows.filter((parsedRow) =>
		parsedRow.some((value) => value.length > 0),
	);
}

function escapeTableCell(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|");
}

export function convertCsvContentToMarkdown(contents: string): string {
	const rows = parseCsvContent(contents);
	if (rows.length === 0) return "";

	const columnCount = Math.max(...rows.map((row) => row.length));
	const pad = (row: string[]): string[] => [
		...row,
		...Array.from({ length: columnCount - row.length }, () => ""),
	];
	const normalizedRows = rows.map(pad);
	const firstRowHasContent = normalizedRows[0]!.some(
		(cell) => cell.length > 0,
	);
	const header = firstRowHasContent
		? normalizedRows[0]!
		: Array.from(
				{ length: columnCount },
				(_, index) => `Column ${index + 1}`,
			);
	const body = firstRowHasContent ? normalizedRows.slice(1) : normalizedRows;

	return [
		`| ${header.map(escapeTableCell).join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
	].join("\n");
}

export async function convertCsvFileToMarkdown(
	filePath: string,
): Promise<string> {
	return convertCsvContentToMarkdown(await readFile(filePath, "utf8"));
}
