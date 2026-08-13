import { assert } from "chai";
import yaml from "js-yaml";
import { describe, it } from "mocha";
import {
	ActionListContractError,
	normalizeActionList,
	normalizeActionListWithDiagnostics,
	normalizeShorthandActionEntry,
} from "../src/agents/executor-utils/action-normalization.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";

describe("action-normalization dropdown_select", () => {
	it("accepts typed dropdown_select", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "dropdown_select",
			ref: "n",
			value: "4",
		});
		assert.deepStrictEqual(parsed, {
			type: "dropdown_select",
			ref: "n",
			value: "4",
		});
	});

	it("accepts shorthand dropdown_select map", () => {
		const parsed = normalizeShorthandActionEntry({
			dropdown_select: { ref: "n", value: "4" },
		});
		assert.deepStrictEqual(parsed, {
			type: "dropdown_select",
			ref: "n",
			value: "4",
		});
	});

	it("allows empty string value (placeholder option)", () => {
		const parsed = normalizeShorthandActionEntry({
			dropdown_select: { ref: "x", value: "" },
		});
		assert.deepStrictEqual(parsed, {
			type: "dropdown_select",
			ref: "x",
			value: "",
		});
	});

	it("coerces numeric value to string", () => {
		const parsed = normalizeShorthandActionEntry({
			dropdown_select: { ref: "x", value: 12 },
		});
		assert.deepStrictEqual(parsed, {
			type: "dropdown_select",
			ref: "x",
			value: "12",
		});
	});

	it("normalizes a list of mixed actions", () => {
		const list = normalizeActionList([
			{ click: "1" },
			{ dropdown_select: { ref: "n", value: "3" } },
			{ type: "type", ref: "2", text: "hi" },
		]);
		assert.strictEqual(list.length, 3);
		assert.deepStrictEqual(list[1], {
			type: "dropdown_select",
			ref: "n",
			value: "3",
		});
	});
});

describe("action-normalization semantic refs", () => {
	it("rejects the removed website_tool action", () => {
		const result = normalizeActionListWithDiagnostics([
			{ type: "website_tool", name: "legacy", inputs: {} },
		]);
		assert.strictEqual(result.status, "rejected");
		assert.include(result.diagnostics[0], "unsupported action type");
	});

	it("rejects obsolete target fields", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				type: "click",
				target: "obsolete-1",
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				type: "dropdown_select",
				target: "obsolete-2",
				value: "Choice",
			}),
		);
	});
});

describe("action-normalization page observations", () => {
	it("accepts the argument-free read_page forms", () => {
		assert.deepEqual(normalizeShorthandActionEntry("read_page"), {
			type: "read_page",
		});
		assert.deepEqual(
			normalizeShorthandActionEntry({ read_page: {} }),
			{ type: "read_page" },
		);
		assert.deepEqual(
			normalizeShorthandActionEntry({ type: "read_page" }),
			{ type: "read_page" },
		);
	});

	it("rejects options on read_page", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				read_page: { maxChars: 10 },
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				type: "read_page",
				view: "details",
			}),
		);
	});

	it("accepts only a scalar project_page target", () => {
		assert.deepEqual(
			normalizeShorthandActionEntry({ project_page: ".result" }),
			{ type: "project_page", target: ".result" },
		);
		assert.deepEqual(
			normalizeShorthandActionEntry({
				type: "project_page",
				target: "r2f",
			}),
			{ type: "project_page", target: "r2f" },
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				project_page: { selector: ".result", limit: 5 },
			}),
		);
	});

	it("accepts only a scalar find_page query", () => {
		assert.deepEqual(
			normalizeShorthandActionEntry({ find_page: "enemy aircraft|gunner" }),
			{ type: "find_page", query: "enemy aircraft|gunner" },
		);
		assert.deepEqual(
			normalizeShorthandActionEntry({
				type: "find_page",
				query: "Havens",
			}),
			{ type: "find_page", query: "Havens" },
		);
		assert.isNull(
			normalizeShorthandActionEntry({ find_page: { query: "Havens" } }),
		);
	});
});

describe("action-normalization paste_file", () => {
	it("accepts typed paste_file", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "paste_file",
			ref: "12",
			path: "./extracted.txt",
		});
		assert.deepStrictEqual(parsed, {
			type: "paste_file",
			ref: "12",
			path: "./extracted.txt",
		});
	});

	it("accepts shorthand paste_file map", () => {
		const parsed = normalizeShorthandActionEntry({
			paste_file: { ref: "12", path: "./extracted.txt" },
		});
		assert.deepStrictEqual(parsed, {
			type: "paste_file",
			ref: "12",
			path: "./extracted.txt",
		});
	});

	it("rejects paste_file without ref or path", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				paste_file: { ref: "12" },
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				paste_file: { path: "./extracted.txt" },
			}),
		);
	});
});

describe("action-normalization return_results", () => {
	it("accepts shorthand string action", () => {
		const parsed = normalizeShorthandActionEntry("return_results");
		assert.deepStrictEqual(parsed, { type: "return_results" });
	});

	it("accepts map shorthand", () => {
		const parsed = normalizeShorthandActionEntry({
			return_results: true,
		});
		assert.deepStrictEqual(parsed, { type: "return_results" });
	});

	it("accepts typed action", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "return_results",
		});
		assert.deepStrictEqual(parsed, { type: "return_results" });
	});

	it("accepts an explicit result list", () => {
		const parsed = normalizeShorthandActionEntry({
			return_results: [
				{
					link: " https://example.com/item ",
					summary: " matching item ",
				},
			],
		});
		assert.deepStrictEqual(parsed, {
			type: "return_results",
			results: [
				{
					link: "https://example.com/item",
					summary: "matching item",
				},
			],
		});
	});

	it("rejects the old memory_return_results tool name", () => {
		assert.isNull(normalizeShorthandActionEntry("memory_return_results"));
		assert.isNull(
			normalizeShorthandActionEntry({
				memory_return_results: true,
			}),
		);
	});
});

describe("action-normalization memory_clear", () => {
	it("accepts shorthand target", () => {
		const parsed = normalizeShorthandActionEntry({
			memory_clear: "memory_result",
		});
		assert.deepStrictEqual(parsed, {
			type: "memory_clear",
			target: "memory_result",
		});
	});

	it("accepts typed target", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "memory_clear",
			target: "all",
		});
		assert.deepStrictEqual(parsed, {
			type: "memory_clear",
			target: "all",
		});
	});

	it("rejects invalid target", () => {
		assert.isNull(normalizeShorthandActionEntry({ memory_clear: "unknown" }));
	});
});

describe("action-normalization extract_data", () => {
	it("accepts bare extract_data only for whole-context extraction", () => {
		const original = configFeatureFlags.extractDataWholeContext;
		try {
			setConfigFeatureFlags({ extractDataWholeContext: false });
			assert.isNull(normalizeShorthandActionEntry("extract_data"));
			assert.isNull(normalizeShorthandActionEntry({ type: "extract_data" }));
			assert.isNull(normalizeShorthandActionEntry({ extract_data: null }));
			assert.isNull(normalizeShorthandActionEntry({ extract_data: "" }));

			setConfigFeatureFlags({ extractDataWholeContext: true });
			assert.deepEqual(normalizeShorthandActionEntry("extract_data"), {
				type: "extract_data",
			});
			assert.deepEqual(
				normalizeShorthandActionEntry({ type: "extract_data" }),
				{ type: "extract_data" },
			);
			assert.deepEqual(normalizeShorthandActionEntry({ extract_data: null }), {
				type: "extract_data",
			});
			assert.deepEqual(normalizeShorthandActionEntry({ extract_data: "" }), {
				type: "extract_data",
			});
		} finally {
			setConfigFeatureFlags({ extractDataWholeContext: original });
		}
	});

	it("accepts implicit and explicit null YAML as whole-context extraction", () => {
		const original = configFeatureFlags.extractDataWholeContext;
		try {
			setConfigFeatureFlags({ extractDataWholeContext: true });
			for (const source of [
				"tools:\n  - extract_data:",
				"tools:\n  - extract_data: null",
				'tools:\n  - extract_data: ""',
			]) {
				const parsed = yaml.load(source) as { tools: unknown[] };
				assert.deepEqual(normalizeActionListWithDiagnostics(parsed.tools), {
					status: "accepted",
					actions: [{ type: "extract_data" }],
					diagnostics: [],
				});
			}
		} finally {
			setConfigFeatureFlags({ extractDataWholeContext: original });
		}
	});

	it("accepts and canonicalizes extract_data roots", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "extract_data",
			root: " !a, 42 ,!b ",
		});
		assert.deepStrictEqual(parsed, {
			type: "extract_data",
			root: "!a,42,!b",
		});
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				extract_data: " !a, 42 ,!b ",
			}),
			{
				type: "extract_data",
				root: "!a,42,!b",
			},
		);
	});

	it("rejects empty root segments and removed range fields", () => {
		for (const extract_data of [
			"",
			"   ",
			"42,",
			",42",
			"42, ,43",
			{ root: "42", start: "43", end_exclusive: "44" },
			{ root: "42", end_exclusive: "44" },
			{ start: "42" },
			{ end_exclusive: "44" },
			{ endExclusive: "44" },
			{ root: "" },
			{ root: "42," },
			{ root: ",42" },
			{ root: "42, ,43" },
			42,
		]) {
			assert.isNull(
				normalizeShorthandActionEntry({
					extract_data,
				}),
			);
		}
	});

	it("rejects nested and legacy per-item contracts", () => {
		for (const legacy of [
			{ root: "42" },
			{ items: [{ ref: "42" }] },
			{ ref: "42" },
			{ root: "42", hierarchy: 0 },
			{ root: "42", url_ref: "43" },
			{ root: "42", write_to: "memory_result" },
			{ root: "42", writeTo: "memory_result" },
		]) {
			assert.isNull(normalizeShorthandActionEntry({ extract_data: legacy }));
		}
	});
});

describe("action-normalization scroll", () => {
	it("accepts typed scroll with numeric deltas", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "scroll",
			ref: "s1",
			deltaX: 0,
			deltaY: 320,
		});
		assert.deepStrictEqual(parsed, {
			type: "scroll",
			ref: "s1",
			deltaX: 0,
			deltaY: 320,
		});
	});

	it("accepts shorthand scroll map", () => {
		const parsed = normalizeShorthandActionEntry({
			scroll: { ref: "s2", deltaY: 240 },
		});
		assert.deepStrictEqual(parsed, {
			type: "scroll",
			ref: "s2",
			deltaY: 240,
		});
	});

	it("coerces string deltas to numbers", () => {
		const parsed = normalizeShorthandActionEntry({
			scroll: { ref: "s3", deltaX: "12.5", deltaY: "-300" },
		});
		assert.deepStrictEqual(parsed, {
			type: "scroll",
			ref: "s3",
			deltaX: 12.5,
			deltaY: -300,
		});
	});

	it("rejects scroll entries with no finite delta values", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				scroll: { ref: "s4" },
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				scroll: { ref: "s4", deltaY: "abc" },
			}),
		);
	});
});

describe("action-normalization agent_takeover", () => {
	it("accepts string-only agent_takeover shorthand", () => {
		const parsed = normalizeShorthandActionEntry({
			agent_takeover: "Extract the service ID from ./bill.pdf.",
		});
		assert.deepStrictEqual(parsed, {
			type: "agent_takeover",
			request: "Extract the service ID from ./bill.pdf.",
		});
	});

	it("accepts typed agent_takeover with a string request", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "agent_takeover",
			request: "Extract the service ID from ./bill.pdf.",
		});
		assert.deepStrictEqual(parsed, {
			type: "agent_takeover",
			request: "Extract the service ID from ./bill.pdf.",
		});
	});

	it("accepts nested agent_takeover maps with request", () => {
		const parsed = normalizeShorthandActionEntry({
			agent_takeover: {
				request: "Extract the service ID.",
				sourceHints: ["./bill.pdf"],
			},
		});
		assert.deepStrictEqual(parsed, {
			type: "agent_takeover",
			request: "Extract the service ID.",
		});
	});

	it("rejects reason as an agent_takeover request alias", () => {
		const result = normalizeActionListWithDiagnostics([
			{
				type: "agent_takeover",
				reason: "Extract the service ID.",
			},
		]);
		assert.strictEqual(result.status, "rejected");
		assert.notProperty(result, "actions");
		assert.deepStrictEqual(result.diagnostics, [
			'actions[0]: agent_takeover requires a non-empty "request" string',
		]);
	});
});

describe("action-normalization user_takeover", () => {
	it("accepts typed user_takeover with a string request", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "user_takeover",
			category: "authentication",
			request: "Use secure authentication handling for sign-in.",
		});
		assert.deepStrictEqual(parsed, {
			type: "user_takeover",
			category: "authentication",
			reason: "Use secure authentication handling for sign-in.",
		});
	});

	it("rejects reason as a user_takeover request alias", () => {
		const result = normalizeActionListWithDiagnostics([
			{
				type: "user_takeover",
				category: "authentication",
				reason: "Use secure authentication handling for sign-in.",
			},
		]);
		assert.strictEqual(result.status, "rejected");
		assert.notProperty(result, "actions");
		assert.deepStrictEqual(result.diagnostics, [
			'actions[0]: user_takeover requires a non-empty "request" string',
		]);
	});

	it("normalizes a single action object instead of dropping it", () => {
		const result = normalizeActionListWithDiagnostics({
			type: "agent_takeover",
			request: "Rename ./downloads/source.pdf to ./downloads/final.pdf.",
		});
		assert.deepStrictEqual(result.actions, [
			{
				type: "agent_takeover",
				request: "Rename ./downloads/source.pdf to ./downloads/final.pdf.",
			},
		]);
		assert.deepStrictEqual(result.diagnostics, []);
	});
});

describe("action-normalization download_current_file", () => {
	it("accepts shorthand string action", () => {
		const parsed = normalizeShorthandActionEntry("download_current_file");
		assert.deepStrictEqual(parsed, { type: "download_current_file" });
	});

	it("accepts map shorthand", () => {
		const parsed = normalizeShorthandActionEntry({
			download_current_file: true,
		});
		assert.deepStrictEqual(parsed, { type: "download_current_file" });
	});

	it("ignores map shorthand targetPath", () => {
		const parsed = normalizeShorthandActionEntry({
			download_current_file: {
				targetPath: "./downloads/financial_report.pdf",
			},
		});
		assert.deepStrictEqual(parsed, { type: "download_current_file" });
	});

	it("ignores typed action targetPath", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "download_current_file",
			targetPath: "./downloads/financial_report.pdf",
		});
		assert.deepStrictEqual(parsed, { type: "download_current_file" });
	});
});

describe("action-normalization upload_files", () => {
	it("accepts typed upload_files", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "upload_files",
			ref: "12",
			paths: ["./report.pdf", "./downloads/file.csv"],
		});
		assert.deepStrictEqual(parsed, {
			type: "upload_files",
			ref: "12",
			paths: ["./report.pdf", "./downloads/file.csv"],
		});
	});

	it("accepts shorthand upload_files map", () => {
		const parsed = normalizeShorthandActionEntry({
			upload_files: {
				ref: "22",
				paths: "./input.txt",
			},
		});
		assert.deepStrictEqual(parsed, {
			type: "upload_files",
			ref: "22",
			paths: ["./input.txt"],
		});
	});

	it("rejects upload_files without ref or paths", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				upload_files: {
					paths: ["./input.txt"],
				},
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				upload_files: {
					ref: "22",
					paths: [],
				},
			}),
		);
	});
});

describe("action-normalization typed wait/type", () => {
	it("accepts the canonical nested type wire form", () => {
		const result = normalizeActionListWithDiagnostics([
			{
				type: {
					ref: "r7",
					text: "query",
					enter: true,
				},
			},
		]);

		assert.deepStrictEqual(result, {
			status: "accepted",
			actions: [
				{
					type: "type",
					ref: "r7",
					text: "query",
					enter: true,
				},
			],
			diagnostics: [],
		});
	});

	it("rejects the obsolete flat type wire form", () => {
		const result = normalizeActionListWithDiagnostics([
			{ type: "r7", text: "query", enter: true },
		]);

		assert.deepStrictEqual(result, {
			status: "rejected",
			diagnostics: ['actions[0]: malformed or unsupported action type "r7"'],
		});
	});

	it("rejects a complete action list when any entry is malformed", () => {
		const result = normalizeActionListWithDiagnostics([
			{ click: "r1" },
			{ type: { text: "missing ref" } },
		]);

		assert.deepStrictEqual(result, {
			status: "rejected",
			diagnostics: [
				"actions[1]: type requires {ref, text, enter?} with a non-empty ref",
			],
		});
		assert.throws(
			() =>
				normalizeActionList([
					{ click: "r1" },
					{ type: { text: "missing ref" } },
				]),
			ActionListContractError,
		);
	});

	it("accepts typed wait when duration is provided as value", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "wait",
			value: 3000,
		});
		assert.deepStrictEqual(parsed, {
			type: "wait",
			ms: 3000,
		});
	});

	it("coerces typed type action text to string", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "type",
			ref: "f",
			text: 20240101,
		});
		assert.deepStrictEqual(parsed, {
			type: "type",
			ref: "f",
			text: "20240101",
		});
	});
});

describe("action-normalization long_press/read_file", () => {
	it("accepts typed and shorthand long_press actions", () => {
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				type: "long_press",
				ref: "hold",
			}),
			{ type: "long_press", ref: "hold" },
		);
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				long_press: { ref: "hold", durationMs: 2500 },
			}),
			{ type: "long_press", ref: "hold", durationMs: 2500 },
		);
	});

	it("rejects invalid long_press duration and missing ref", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				long_press: { ref: "hold", durationMs: 99 },
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				long_press: { durationMs: 1000 },
			}),
		);
	});

	it("accepts typed internal and scalar shorthand read_file actions", () => {
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				type: "read_file",
				path: "./downloads/source.pdf",
			}),
			{ type: "read_file", path: "./downloads/source.pdf" },
		);
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				read_file: "./notes.txt",
			}),
			{ type: "read_file", path: "./notes.txt" },
		);
	});

	it("rejects the obsolete nested read_file shorthand", () => {
		const result = normalizeActionListWithDiagnostics([
			{ read_file: { path: "./notes.txt" } },
		]);
		assert.strictEqual(result.status, "rejected");
		assert.include(result.diagnostics[0] ?? "", "path scalar");
	});
});
