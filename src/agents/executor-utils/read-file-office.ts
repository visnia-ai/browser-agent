import { readFile } from "node:fs/promises";
import { MarkItDown } from "markitdown-ts";

export type OfficeExtension = ".docx" | ".xlsx";

export async function convertOfficeFileToMarkdown(
	filePath: string,
	extension: OfficeExtension,
): Promise<string> {
	const converter = new MarkItDown();
	const result = await converter.convertBuffer(await readFile(filePath), {
		file_extension: extension,
	});
	if (!result?.markdown) {
		throw new Error(
			`${extension.slice(1).toUpperCase()} conversion returned no Markdown`,
		);
	}
	return result.markdown;
}
