import yaml from "js-yaml";

function validateMemoryResultYamlList(result: string): void {
	let parsed: unknown;
	try {
		parsed = yaml.load(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`memory_result must be a valid YAML list: ${message}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error("memory_result must be a YAML list");
	}
	if (parsed.length === 0) {
		throw new Error("memory_result YAML list must not be empty");
	}
}

export function extractMemoryResults(content: string): string {
	const result = content.trim();
	if (!result) {
		throw new Error("empty memory_result");
	}
	validateMemoryResultYamlList(result);
	return result;
}
