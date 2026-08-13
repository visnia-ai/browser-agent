import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

export const CUSTOM_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const BUILT_IN_TOOL_NAMES = new Set([
	"click",
	"long_press",
	"type",
	"scroll",
	"evaluate",
	"dropdown_select",
	"navigate",
	"switch_tab",
	"wait",
	"download_current_file",
	"upload_files",
	"paste_file",
	"user_takeover",
	"memory_write",
	"memory_read",
	"read_file",
	"return_results",
	"memory_clear",
	"extract_data",
	"agent_takeover",
]);

export interface CustomToolDefinition {
	name: string;
	description: string;
	arguments: Record<string, unknown>;
	javascript: string;
}

export interface CustomToolRegistryEntry extends CustomToolDefinition {
	validateArguments: ValidateFunction;
}

export type CustomToolRegistry = ReadonlyMap<string, CustomToolRegistryEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(context: string, message: string): never {
	throw new Error(`${context}: ${message}`);
}

export function compileCustomTools(
	value: unknown,
	context = "custom_tools",
): CustomToolRegistry {
	if (value === undefined) return new Map();
	if (!Array.isArray(value)) invalid(context, "must be an array");
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const registry = new Map<string, CustomToolRegistryEntry>();
	for (const [index, candidate] of value.entries()) {
		const itemContext = `${context}[${index}]`;
		if (!isRecord(candidate)) invalid(itemContext, "must be an object");
		for (const key of Object.keys(candidate)) {
			if (!["name", "description", "arguments", "javascript"].includes(key)) {
				invalid(itemContext, `.${key} is not supported`);
			}
		}
		const name = typeof candidate.name === "string" ? candidate.name : "";
		if (!CUSTOM_TOOL_NAME_PATTERN.test(name)) {
			invalid(itemContext, "name must match ^[a-z][a-z0-9_]{0,63}$");
		}
		if (BUILT_IN_TOOL_NAMES.has(name)) {
			invalid(itemContext, `name \"${name}\" collides with a built-in tool`);
		}
		if (registry.has(name)) invalid(itemContext, `duplicate name \"${name}\"`);
		const description =
			typeof candidate.description === "string"
				? candidate.description.trim()
				: "";
		if (!description) invalid(itemContext, "description must be non-empty");
		const argumentSchema = candidate.arguments;
		if (!isRecord(argumentSchema) || argumentSchema.type !== "object") {
			invalid(itemContext, "arguments must be a JSON Schema with type \"object\"");
		}
		let validateArguments: ValidateFunction;
		try {
			validateArguments = ajv.compile(argumentSchema);
		} catch (error) {
			invalid(
				itemContext,
				`arguments is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const javascript =
			typeof candidate.javascript === "string" ? candidate.javascript.trim() : "";
		if (!javascript) invalid(itemContext, "javascript must be non-empty");
		registry.set(name, {
			name,
			description,
			arguments: argumentSchema,
			javascript,
			validateArguments,
		});
	}
	return registry;
}

export function customToolDefinitions(
	registry: CustomToolRegistry | undefined,
): CustomToolDefinition[] {
	return [...(registry?.values() ?? [])].map(
		({ name, description, arguments: argumentSchema, javascript }) => ({
			name,
			description,
			arguments: argumentSchema,
			javascript,
		}),
	);
}

export function customToolPublicMetadata(
	registry: CustomToolRegistry | undefined,
): Array<Omit<CustomToolDefinition, "javascript">> {
	return [...(registry?.values() ?? [])].map(
		({ name, description, arguments: argumentSchema }) => ({
			name,
			description,
			arguments: argumentSchema,
		}),
	);
}
