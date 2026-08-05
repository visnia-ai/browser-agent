import yaml from "js-yaml";

export interface ExtractedDataResultItem {
	link: string;
	summary: string;
}

function validateItems(
	items: ExtractedDataResultItem[],
): ExtractedDataResultItem[] {
	if (items.length === 0) {
		throw new Error("extract_data returned no items");
	}
	return items.map((item, index) => {
		const link = item.link.trim();
		const summary = item.summary.trim();
		if (!link) {
			throw new Error(`extract_data item ${index + 1} has an empty link`);
		}
		if (!summary) {
			throw new Error(
				`extract_data item ${index + 1} has an empty summary`,
			);
		}
		return { link, summary };
	});
}

export function formatMemoryResultBlock(
	items: ExtractedDataResultItem[],
): string {
	return yaml.dump(validateItems(items), { lineWidth: -1 }).trim();
}
