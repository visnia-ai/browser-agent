import { assert } from "chai";
import { describe, it } from "mocha";
import {
	appendMemoryFile,
	appendMemoryResultItems,
	clearMemoryContent,
	normalizeMemoryContentForRead,
	replaceMemoryResultItems,
} from "../src/agents/executor-utils/memory-file.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

describe("memory file helpers", () => {
	it("appends memory blocks", () => {
		const filePath = path.join(os.tmpdir(), "memory-append-test.txt");
		try {
			fs.writeFileSync(filePath, "first", "utf-8");
			appendMemoryFile({ filePath, content: "second" });
			assert.strictEqual(
				fs.readFileSync(filePath, "utf-8"),
				"first\n\nsecond",
			);
		} finally {
			fs.rmSync(filePath, { force: true });
		}
	});

	it("clears targeted memory content", () => {
		assert.strictEqual(
			clearMemoryContent({ target: "memory", content: "anything" }),
			"",
		);
		assert.strictEqual(
			clearMemoryContent({
				target: "memory_result",
				content: "- link: https://example.com\n  summary: Result",
			}),
			"",
		);
		assert.strictEqual(
			clearMemoryContent({ target: "all", content: "anything" }),
			"",
		);
	});

	it("appends result items as a plain YAML list", () => {
		const filePath = path.join(
			os.tmpdir(),
			"memory-result-append-test.txt",
		);
		try {
			fs.writeFileSync(
				filePath,
				[
					"- link: https://example.com/one",
					'  summary: "Existing: item"',
				].join("\n"),
				"utf-8",
			);
			appendMemoryResultItems({
				filePath,
				items: [
					{
						link: "https://example.com/two?x=1&y=2",
						summary: 'New item: "quoted"\nSecond line',
					},
				],
			});
			const content = fs.readFileSync(filePath, "utf-8");
			assert.deepStrictEqual(yaml.load(content), [
				{
					link: "https://example.com/one",
					summary: "Existing: item",
				},
				{
					link: "https://example.com/two?x=1&y=2",
					summary: 'New item: "quoted"\nSecond line',
				},
			]);
		} finally {
			fs.rmSync(filePath, { force: true });
		}
	});

	it("normalizes memory content by trimming only", () => {
		assert.strictEqual(normalizeMemoryContentForRead("  note\n"), "note");
	});

	it("atomically replaces result items without leaving temp files", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "memory-replace-test-"),
		);
		const filePath = path.join(dir, "result.txt");
		try {
			fs.writeFileSync(
				filePath,
				"- link: https://old.example\n  summary: old",
				"utf-8",
			);
			replaceMemoryResultItems({
				filePath,
				items: [{ link: "https://new.example", summary: "new" }],
			});
			assert.deepStrictEqual(
				yaml.load(fs.readFileSync(filePath, "utf-8")),
				[{ link: "https://new.example", summary: "new" }],
			);
			assert.deepStrictEqual(fs.readdirSync(dir), ["result.txt"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
