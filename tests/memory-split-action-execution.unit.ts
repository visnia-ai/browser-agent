import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert } from "chai";
import yaml from "js-yaml";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { DataExtractionCoordinator } from "../src/agents/executor-utils/data-extraction-coordinator.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMemoryFiles(prefix: string): {
	dir: string;
	memoryFile: string;
	extractDataMemoryFile: string;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const memoryFile = path.join(dir, "memory.txt");
	const extractDataMemoryFile = path.join(dir, "extract-data-memory.txt");
	fs.writeFileSync(memoryFile, "", "utf-8");
	fs.writeFileSync(extractDataMemoryFile, "", "utf-8");
	return { dir, memoryFile, extractDataMemoryFile };
}

describe("memory split action execution", () => {
	it("passes the entire DOM for rootless whole-context extraction", async () => {
		const files = createMemoryFiles("memory-whole-document-");
		const original = configFeatureFlags.extractDataWholeContext;
		const wholeDom = [
			'div: "Header"',
			'  link ref="r1" href="/one" name="First"',
			'div: "Footer"',
		].join("\n");
		let observedPageProjection: string | undefined;
		let observedTraceMeta: Record<string, unknown> | undefined;
		try {
			setConfigFeatureFlags({ extractDataWholeContext: true });
			await executeActions({
				b: {} as never,
				actions: [{ type: "extract_data" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				stepNumber: 4,
				currentUrl: "https://example.com/current",
				pageProjection: wholeDom,
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
					reasoningEffort: "none",
				},
				extractDataResultsFromSnapshot: async ({
					pageProjection,
					traceOptions,
				}) => {
					observedPageProjection = pageProjection;
					observedTraceMeta = traceOptions?.meta;
					return {
						items: [
							{
								link: "https://example.com/one",
								summary: "whole document result",
							},
						],
					};
				},
			});

			assert.strictEqual(observedPageProjection, wholeDom);
			assert.deepEqual(observedTraceMeta, {
				step: 4,
				currentUrl: "https://example.com/current",
				scope: "whole_document",
			});
		} finally {
			setConfigFeatureFlags({ extractDataWholeContext: original });
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("passes one identifier-free region with task, URL, and trace metadata", async () => {
		const files = createMemoryFiles("memory-region-");
		let observedPageProjection: string | undefined;
		let observedTraceMeta: Record<string, unknown> | undefined;
		let observedTask: string | undefined;
		let observedCurrentUrl: string | undefined;
		try {
			await executeActions({
				b: {} as never,
				actions: [
					{
						type: "extract_data",
						root: "!root",
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				stepNumber: 7,
				userTask: "Extract the greeting",
				currentUrl: "https://example.com/current",
				pageProjection: [
					'document ref="!root" name="Hello world"',
					'  button ref="login" name="Login"',
					'    div: "Goodbye world"',
					'document ref="!after" name="ignored"',
				].join("\n"),
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async ({
					task,
					currentUrl,
					pageProjection,
					traceOptions,
				}) => {
					observedTask = task;
					observedCurrentUrl = currentUrl;
					observedPageProjection = pageProjection;
					observedTraceMeta = traceOptions?.meta;
					return {
						items: [
							{
								link: "https://example.com/login",
								summary: "region result",
							},
						],
					};
				},
			});

			assert.strictEqual(
				observedPageProjection,
				[
					'document ref="!root" name="Hello world"',
					'  button ref="login" name="Login"',
					'    div: "Goodbye world"',
				].join("\n"),
			);
			assert.strictEqual(observedTask, "Extract the greeting");
			assert.strictEqual(
				observedCurrentUrl,
				"https://example.com/current",
			);
			assert.deepEqual(observedTraceMeta, {
				step: 7,
				currentUrl: "https://example.com/current",
				scope: "rooted_subtree",
				root: "!root",
			});
		} finally {
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("always writes extracted data as a valid YAML list in result memory", async () => {
		const files = createMemoryFiles("memory-split-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		try {
			await executeActions({
				b: {} as never,
				actions: [
					{ type: "memory_write", content: "scratch note" },
					{
						type: "extract_data",
						root: "item",
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="item" name="extracted note"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async () => ({
					items: [
						{
							link: "https://example.com/item",
							summary: "extracted note",
						},
					],
				}),
			});
			await dataExtractionCoordinator.waitForAllAndFlush({
				filePath: files.extractDataMemoryFile,
			});

			assert.include(
				fs.readFileSync(files.memoryFile, "utf-8"),
				"scratch note",
			);
			assert.notInclude(
				fs.readFileSync(files.memoryFile, "utf-8"),
				"extracted note",
			);
			const extractedData = fs.readFileSync(
				files.extractDataMemoryFile,
				"utf-8",
			);
			assert.notInclude(extractedData, "Extracted data:");
			assert.deepStrictEqual(yaml.load(extractedData), [
				{
					link: "https://example.com/item",
					summary: "extracted note",
				},
			]);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("passes full href context and current URL to one extraction call", async () => {
		const files = createMemoryFiles("memory-href-context-");
		let observedCurrentUrl: string | undefined;
		let observedPageProjection: string | undefined;
		let callCount = 0;
		try {
			await executeActions({
				b: {} as never,
				actions: [
					{
						type: "extract_data",
						root: "!results",
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				currentUrl: "https://example.com/current",
				pageProjection: [
					'document ref="!results" name="Results"',
					'  link ref="item" href="/snapshot-item?x=1" name="extracted note"',
				].join("\n"),
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async ({
					currentUrl,
					pageProjection,
				}) => {
					callCount++;
					observedCurrentUrl = currentUrl;
					observedPageProjection = pageProjection;
					return {
						items: [
							{
								link: "https://example.com/snapshot-item?x=1",
								summary: "snapshot extracted note",
							},
						],
					};
				},
			});

			assert.strictEqual(callCount, 1);
			assert.strictEqual(
				observedCurrentUrl,
				"https://example.com/current",
			);
			assert.include(observedPageProjection, 'href="/snapshot-item?x=1"');
			assert.include(observedPageProjection, 'ref="!results"');
			assert.include(observedPageProjection, 'ref="item"');
		} finally {
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("keeps standalone memory clears destructive", async () => {
		const files = createMemoryFiles("memory-clear-");
		try {
			fs.writeFileSync(files.memoryFile, "scratch", "utf-8");
			fs.writeFileSync(files.extractDataMemoryFile, "extract", "utf-8");
			await executeActions({
				b: {} as never,
				actions: [{ type: "memory_clear", target: "memory_result" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
			});
			assert.strictEqual(
				fs.readFileSync(files.memoryFile, "utf-8"),
				"scratch",
			);
			assert.strictEqual(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				"",
			);
		} finally {
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("atomically replaces result memory after asynchronous extraction succeeds", async () => {
		const files = createMemoryFiles("memory-replace-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		try {
			fs.writeFileSync(
				files.extractDataMemoryFile,
				"- link: https://old.example\n  summary: old",
				"utf-8",
			);
			await executeActions({
				b: {} as never,
				actions: [
					{ type: "memory_clear", target: "memory_result" },
					{
						type: "extract_data",
						root: "new",
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="new" name="replacement"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async () => ({
					items: [
						{ link: "https://new.example", summary: "replacement" },
					],
				}),
			});
			await dataExtractionCoordinator.waitForAllAndFlush({
				filePath: files.extractDataMemoryFile,
			});

			const content = fs.readFileSync(
				files.extractDataMemoryFile,
				"utf-8",
			);
			assert.include(content, "https://new.example");
			assert.notInclude(content, "https://old.example");
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("preserves result memory when asynchronous replacement fails", async () => {
		const files = createMemoryFiles("memory-preserve-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		const existing = "- link: https://old.example\n  summary: old";
		try {
			fs.writeFileSync(files.extractDataMemoryFile, existing, "utf-8");
			await executeActions({
				b: {} as never,
				actions: [
					{ type: "memory_clear", target: "memory_result" },
					{
						type: "extract_data",
						root: "item",
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="item" name="note"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async () => {
					throw new Error("replacement failed");
				},
			});
			const barrier = await dataExtractionCoordinator.waitForAllAndFlush({
				filePath: files.extractDataMemoryFile,
			});

			assert.include(barrier.errors.join(" | "), "replacement failed");
			assert.strictEqual(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				existing,
			);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("clears scratchpad immediately while transactionally replacing results", async () => {
		const files = createMemoryFiles("memory-replace-all-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		try {
			fs.writeFileSync(files.memoryFile, "scratch", "utf-8");
			fs.writeFileSync(
				files.extractDataMemoryFile,
				"- link: https://old.example\n  summary: old",
				"utf-8",
			);
			await executeActions({
				b: {} as never,
				actions: [
					{ type: "memory_clear", target: "all" },
					{
						type: "extract_data",
						root: "new",
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="new" name="replacement"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async () => ({
					items: [
						{ link: "https://new.example", summary: "replacement" },
					],
				}),
			});
			await dataExtractionCoordinator.waitForAllAndFlush({
				filePath: files.extractDataMemoryFile,
			});

			assert.strictEqual(fs.readFileSync(files.memoryFile, "utf-8"), "");
			const content = fs.readFileSync(
				files.extractDataMemoryFile,
				"utf-8",
			);
			assert.include(content, "https://new.example");
			assert.notInclude(content, "https://old.example");
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("continues following actions while extraction runs asynchronously", async () => {
		const files = createMemoryFiles("memory-sync-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		const releaseExtraction = deferred();
		try {
			await executeActions({
				b: {} as never,
				actions: [
					{
						type: "extract_data",
						root: "item",
					},
					{ type: "memory_write", content: "after extraction" },
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="item" name="extracted note"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async () => {
					await releaseExtraction.promise;
					return {
						items: [
							{
								link: "https://example.com/item",
								summary: "extracted note",
							},
						],
					};
				},
			});

			assert.include(
				fs.readFileSync(files.memoryFile, "utf-8"),
				"after extraction",
			);
			assert.strictEqual(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				"",
			);

			releaseExtraction.resolve();
			await dataExtractionCoordinator.waitForAllAndFlush({
				filePath: files.extractDataMemoryFile,
			});
			assert.include(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				"extracted note",
			);
		} finally {
			releaseExtraction.resolve();
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("waits at memory_read until pending extraction is persisted", async () => {
		const files = createMemoryFiles("memory-read-barrier-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		const releaseExtraction = deferred<{
			items: { link: string; summary: string }[];
		}>();
		try {
			await executeActions({
				b: {} as never,
				actions: [{ type: "extract_data", root: "item" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="item" name="extracted note"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async () =>
					await releaseExtraction.promise,
			});

			let memoryReadSettled = false;
			const memoryReadPromise = executeActions({
				b: {} as never,
				actions: [{ type: "memory_read" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
			}).then((result) => {
				memoryReadSettled = true;
				return result;
			});

			await delay(10);
			assert.isFalse(memoryReadSettled);
			releaseExtraction.resolve({
				items: [
					{
						link: "https://example.com/item",
						summary: "extracted note",
					},
				],
			});
			const result = await memoryReadPromise;

			assert.isTrue(result.pendingMemoryRead);
			assert.include(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				"extracted note",
			);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("waits at return_results and returns the completed extraction", async () => {
		const files = createMemoryFiles("return-results-barrier-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		const releaseExtraction = deferred<{
			items: { link: string; summary: string }[];
		}>();
		try {
			await executeActions({
				b: {} as never,
				actions: [{ type: "extract_data", root: "item" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="item" name="extracted note"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async () =>
					await releaseExtraction.promise,
			});

			let returnSettled = false;
			const returnPromise = executeActions({
				b: {} as never,
				actions: [{ type: "return_results" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				memoryContentAvailable: true,
			}).then((result) => {
				returnSettled = true;
				return result;
			});

			await delay(10);
			assert.isFalse(returnSettled);
			releaseExtraction.resolve({
				items: [
					{
						link: "https://example.com/item",
						summary: "finished",
					},
				],
			});
			const result = await returnPromise;

			assert.deepStrictEqual(yaml.load(result.returnedResult ?? ""), [
				{
					link: "https://example.com/item",
					summary: "finished",
				},
			]);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("returns completed extraction directly without a memory_read step", async () => {
		const files = createMemoryFiles("direct-extract-return-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		try {
			const result = await executeActions({
				b: {} as never,
				actions: [
					{ type: "extract_data", root: "item" },
					{ type: "return_results" },
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="item" name="extracted note"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async () => ({
					items: [
						{
							link: "https://example.com/item",
							summary: "finished",
						},
					],
				}),
			});

			assert.deepStrictEqual(yaml.load(result.returnedResult ?? ""), [
				{
					link: "https://example.com/item",
					summary: "finished",
				},
			]);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("stores read_file output in result memory and can return it verbatim", async () => {
		const files = createMemoryFiles("read-file-return-");
		const sourcePath = path.join(files.dir, "notes.txt");
		fs.writeFileSync(sourcePath, "Grounded local file content.", "utf-8");
		try {
			const result = await executeActions({
				b: {
					fileWorkspaceRoot: files.dir,
					downloadDir: files.dir,
				} as never,
				actions: [
					{ type: "read_file", path: "./notes.txt" },
					{ type: "return_results" },
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				fileWorkspaceRoot: files.dir,
				workspaceFiles: ["./notes.txt"],
			});

			assert.isTrue(result.pendingMemoryRead);
			assert.deepStrictEqual(yaml.load(result.returnedResult ?? ""), [
				{
					link: "file:./notes.txt",
					summary: "Grounded local file content.",
				},
			]);
		} finally {
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("allows synthesis from read_file memory on the following step", async () => {
		const files = createMemoryFiles("read-file-synthesis-");
		const sourcePath = path.join(files.dir, "notes.txt");
		fs.writeFileSync(sourcePath, "Evidence for synthesis.", "utf-8");
		try {
			await executeActions({
				b: {
					fileWorkspaceRoot: files.dir,
					downloadDir: files.dir,
				} as never,
				actions: [{ type: "read_file", path: "./notes.txt" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				fileWorkspaceRoot: files.dir,
				workspaceFiles: ["./notes.txt"],
			});
			const result = await executeActions({
				b: {} as never,
				actions: [
					{
						type: "return_results",
						results: [
							{
								link: "file:./notes.txt",
								summary: "Synthesized from the file evidence.",
							},
						],
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				memoryContentAvailable: true,
			});

			assert.deepStrictEqual(yaml.load(result.returnedResult ?? ""), [
				{
					link: "file:./notes.txt",
					summary: "Synthesized from the file evidence.",
				},
			]);
		} finally {
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("persists concurrent extractions in launch order", async () => {
		const files = createMemoryFiles("memory-extraction-order-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		const first = deferred<{
			items: { link: string; summary: string }[];
		}>();
		const second = deferred<{
			items: { link: string; summary: string }[];
		}>();
		try {
			for (const [root, extraction] of [
				["first", first],
				["second", second],
			] as const) {
				await executeActions({
					b: {} as never,
					actions: [{ type: "extract_data", root }],
					openTabs: [],
					memoryFile: files.memoryFile,
					extractDataMemoryFile: files.extractDataMemoryFile,
					dataExtractionCoordinator,
					pageProjection: `article ref="${root}" name="${root}"`,
					dataExtractionLLMOptions: {
						provider: "openai",
						model: "gpt-test",
					},
					extractDataResultsFromSnapshot: async () =>
						await extraction.promise,
				});
			}

			const barrierPromise = executeActions({
				b: {} as never,
				actions: [{ type: "memory_read" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
			});
			second.resolve({
				items: [{ link: "https://second.example", summary: "second" }],
			});
			await delay(10);
			assert.strictEqual(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				"",
			);
			first.resolve({
				items: [{ link: "https://first.example", summary: "first" }],
			});
			await barrierPromise;

			assert.deepStrictEqual(
				(
					yaml.load(
						fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
					) as { link: string }[]
				).map((item) => item.link),
				["https://first.example", "https://second.example"],
			);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("persists successful siblings but skips a failed memory_read barrier", async () => {
		const files = createMemoryFiles("memory-extraction-failure-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		try {
			for (const root of ["good", "bad"]) {
				await executeActions({
					b: {} as never,
					actions: [{ type: "extract_data", root }],
					openTabs: [],
					memoryFile: files.memoryFile,
					extractDataMemoryFile: files.extractDataMemoryFile,
					dataExtractionCoordinator,
					pageProjection: `article ref="${root}" name="${root}"`,
					dataExtractionLLMOptions: {
						provider: "openai",
						model: "gpt-test",
					},
					extractDataResultsFromSnapshot: async () => {
						if (root === "bad") throw new Error("model failed");
						return {
							items: [
								{
									link: "https://good.example",
									summary: "good",
								},
							],
						};
					},
				});
			}

			const failedBarrier = await executeActions({
				b: {} as never,
				actions: [
					{ type: "memory_read" },
					{ type: "memory_write", content: "must be skipped" },
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
			});

			assert.isFalse(failedBarrier.pendingMemoryRead);
			assert.include(
				failedBarrier.interactionErrors.join(" | "),
				"extract_data(root=bad): model failed",
			);
			assert.strictEqual(fs.readFileSync(files.memoryFile, "utf-8"), "");
			assert.include(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				"https://good.example",
			);

			const retry = await executeActions({
				b: {} as never,
				actions: [{ type: "memory_read" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
			});
			assert.isTrue(retry.pendingMemoryRead);
			assert.deepStrictEqual(retry.interactionErrors, []);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("times out extraction, aborts it, and ignores late completion", async () => {
		const files = createMemoryFiles("memory-extraction-timeout-");
		const dataExtractionCoordinator = new DataExtractionCoordinator({
			timeoutMs: 20,
		});
		const lateExtraction = deferred<{
			items: { link: string; summary: string }[];
		}>();
		let extractionSignal: AbortSignal | undefined;
		try {
			await executeActions({
				b: {} as never,
				actions: [{ type: "extract_data", root: "slow" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="slow" name="slow"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async ({ abortSignal }) => {
					extractionSignal = abortSignal;
					return await lateExtraction.promise;
				},
			});

			const result = await executeActions({
				b: {} as never,
				actions: [{ type: "memory_read" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
			});
			assert.isFalse(result.pendingMemoryRead);
			assert.match(
				result.interactionErrors.join(" | "),
				/extract_data\(root=slow\): timed out after 20ms/,
			);
			assert.isTrue(extractionSignal?.aborted);

			lateExtraction.resolve({
				items: [{ link: "https://late.example", summary: "late" }],
			});
			await delay(10);
			await dataExtractionCoordinator.waitForAllAndFlush({
				filePath: files.extractDataMemoryFile,
			});
			assert.strictEqual(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				"",
			);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("cancels and discards pending extraction on result-memory clear", async () => {
		const files = createMemoryFiles("memory-extraction-clear-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		const lateExtraction = deferred<{
			items: { link: string; summary: string }[];
		}>();
		let extractionSignal: AbortSignal | undefined;
		try {
			fs.writeFileSync(
				files.extractDataMemoryFile,
				"- link: https://old.example\n  summary: old",
				"utf-8",
			);
			await executeActions({
				b: {} as never,
				actions: [{ type: "extract_data", root: "pending" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: 'article ref="pending" name="pending"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async ({ abortSignal }) => {
					extractionSignal = abortSignal;
					return await lateExtraction.promise;
				},
			});
			await executeActions({
				b: {} as never,
				actions: [{ type: "memory_clear", target: "memory_result" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
			});

			assert.isTrue(extractionSignal?.aborted);
			lateExtraction.resolve({
				items: [{ link: "https://late.example", summary: "late" }],
			});
			await delay(10);
			await dataExtractionCoordinator.waitForAllAndFlush({
				filePath: files.extractDataMemoryFile,
			});
			assert.strictEqual(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				"",
			);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("passes combined roots in DOM order to one model call", async () => {
		const files = createMemoryFiles("memory-single-call-");
		const dataExtractionCoordinator = new DataExtractionCoordinator();
		let callCount = 0;
		let observedPageProjection: string | undefined;
		try {
			await executeActions({
				b: {} as never,
				actions: [
					{
						type: "extract_data",
						root: "second,first",
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				dataExtractionCoordinator,
				pageProjection: [
					'article ref="first" name="first note"',
					'  link ref="first-link" href="/first" name="Open first"',
					'article ref="second" name="second note"',
					'  link ref="second-link" href="/second" name="Open second"',
				].join("\n"),
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async ({ pageProjection }) => {
					callCount++;
					observedPageProjection = pageProjection;
					return {
						items: [
							{
								link: "https://example.com/first",
								summary: "first note",
							},
							{
								link: "https://example.com/second",
								summary: "second note",
							},
						],
					};
				},
			});
			await dataExtractionCoordinator.waitForAllAndFlush({
				filePath: files.extractDataMemoryFile,
			});

			assert.strictEqual(callCount, 1);
			assert.strictEqual(
				observedPageProjection,
				[
					'article ref="first" name="first note"',
					'  link ref="first-link" href="/first" name="Open first"',
					'article ref="second" name="second note"',
					'  link ref="second-link" href="/second" name="Open second"',
				].join("\n"),
			);
			const content = fs.readFileSync(
				files.extractDataMemoryFile,
				"utf-8",
			);
			assert.isBelow(
				content.indexOf("https://example.com/first"),
				content.indexOf("https://example.com/second"),
			);
		} finally {
			dataExtractionCoordinator.close();
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("fails atomically before extraction when one root is missing", async () => {
		const files = createMemoryFiles("memory-missing-root-");
		const existing = "- link: https://old.example\n  summary: old";
		let callCount = 0;
		try {
			fs.writeFileSync(files.extractDataMemoryFile, existing, "utf-8");
			const result = await executeActions({
				b: {} as never,
				actions: [
					{
						type: "extract_data",
						root: "first,missing",
					},
				],
				openTabs: [],
				memoryFile: files.memoryFile,
				extractDataMemoryFile: files.extractDataMemoryFile,
				pageProjection: 'article ref="first" name="first note"',
				dataExtractionLLMOptions: {
					provider: "openai",
					model: "gpt-test",
				},
				extractDataResultsFromSnapshot: async () => {
					callCount++;
					return { items: [] };
				},
			});

			assert.strictEqual(callCount, 0);
			assert.match(
				result.interactionErrors.join(" | "),
				/missing.*not found|not found.*missing/i,
			);
			assert.strictEqual(
				fs.readFileSync(files.extractDataMemoryFile, "utf-8"),
				existing,
			);
		} finally {
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});
});
