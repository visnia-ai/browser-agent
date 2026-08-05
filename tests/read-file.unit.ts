import { assert } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "mocha";
import {
	convertCsvContentToMarkdown,
	parseCsvContent,
} from "../src/agents/executor-utils/read-file-csv.js";
import {
	readLocalFile,
	resolveReadableFilePath,
	type ReadFileExtractors,
} from "../src/agents/executor-utils/read-file.js";

const temporaryDirectories: string[] = [];

function createWorkspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-file-"));
	temporaryDirectories.push(root);
	return root;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("read_file", () => {
	it("reads bounded text from an unlisted workspace path", async () => {
		const root = createWorkspace();
		fs.writeFileSync(path.join(root, "notes.txt"), "hello\nworld\n");

		const result = await readLocalFile({
			requestedPath: "./notes.txt",
			downloadedFiles: [],
			fileWorkspaceRoot: root,
		});

		assert.deepEqual(result, {
			path: "./notes.txt",
			content: "hello\nworld",
			method: "text",
			truncated: false,
		});
	});

	it("resolves completed downloads and rejects unsafe or unavailable paths", () => {
		const root = createWorkspace();
		const downloads = path.join(root, "downloads");
		fs.mkdirSync(downloads);
		fs.writeFileSync(path.join(downloads, "report.pdf"), "pdf");
		const input = {
			downloadedFiles: ["[NEW] ./downloads/report.pdf"],
			fileWorkspaceRoot: root,
			downloadDir: downloads,
		};

		assert.strictEqual(
			resolveReadableFilePath({
				...input,
				requestedPath: "./downloads/report.pdf",
			}).resolvedPath,
			fs.realpathSync(path.join(downloads, "report.pdf")),
		);
		for (const requestedPath of [
			"/etc/passwd",
			"./../secret.txt",
			"./missing.txt",
		]) {
			assert.throws(() =>
				resolveReadableFilePath({ ...input, requestedPath }),
			);
		}
		assert.throws(
			() =>
				resolveReadableFilePath({
					...input,
					requestedPath: "./pending.pdf",
					downloadedFiles: ["[DOWNLOADING] ./pending.pdf"],
				}),
			"in-progress download",
		);
	});

	it("maps only the current scoped download to its stable logical path", () => {
		const root = createWorkspace();
		const downloadRoot = path.join(root, "downloads");
		const currentDownloadDir = path.join(
			downloadRoot,
			"task-001",
			"run-001-attempt-001",
		);
		const siblingDownloadDir = path.join(
			downloadRoot,
			"task-002",
			"run-001-attempt-001",
		);
		fs.mkdirSync(currentDownloadDir, { recursive: true });
		fs.mkdirSync(siblingDownloadDir, { recursive: true });
		fs.writeFileSync(
			path.join(currentDownloadDir, "current.txt"),
			"current",
		);
		fs.writeFileSync(
			path.join(siblingDownloadDir, "sibling.txt"),
			"sibling",
		);

		const roots = {
			fileWorkspaceRoot: root,
			downloadDir: currentDownloadDir,
			downloadRootDir: downloadRoot,
			downloadedFiles: ["./downloads/current.txt"],
		};
		assert.strictEqual(
			resolveReadableFilePath({
				...roots,
				requestedPath: "./downloads/current.txt",
			}).resolvedPath,
			fs.realpathSync(path.join(currentDownloadDir, "current.txt")),
		);
		assert.throws(
			() =>
				resolveReadableFilePath({
					...roots,
					requestedPath:
						"./downloads/task-002/run-001-attempt-001/sibling.txt",
				}),
			"unavailable",
		);
	});

	it("rejects hidden workspace paths", () => {
		const root = createWorkspace();
		fs.mkdirSync(path.join(root, ".hidden"));
		fs.writeFileSync(path.join(root, ".hidden", "secret.txt"), "secret");

		assert.throws(
			() =>
				resolveReadableFilePath({
					requestedPath: "./.hidden/secret.txt",
					downloadedFiles: [],
					fileWorkspaceRoot: root,
				}),
			"hidden path segments",
		);
	});

	it("rejects a symlink that resolves outside the workspace", () => {
		const root = createWorkspace();
		const outside = createWorkspace();
		fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
		fs.symlinkSync(
			path.join(outside, "secret.txt"),
			path.join(root, "listed.txt"),
		);

		assert.throws(
			() =>
				resolveReadableFilePath({
					requestedPath: "./listed.txt",
					downloadedFiles: [],
					fileWorkspaceRoot: root,
				}),
			"unavailable",
		);
	});

	it("uses bounded in-process extraction when a PDF has a text layer", async () => {
		const root = createWorkspace();
		fs.writeFileSync(path.join(root, "report.pdf"), "%PDF");
		const calls: string[] = [];
		const extractors: ReadFileExtractors = {
			extractPdfText: async (filePath) => {
				calls.push(filePath);
				return "PDF text layer";
			},
			recognizeImage: async () => {
				throw new Error("unexpected OCR");
			},
		};

		const result = await readLocalFile({
			requestedPath: "./report.pdf",
			downloadedFiles: [],
			fileWorkspaceRoot: root,
			extractors,
		});

		assert.strictEqual(result.method, "pdf_text");
		assert.strictEqual(result.content, "PDF text layer");
		assert.deepEqual(calls, [
			fs.realpathSync(path.join(root, "report.pdf")),
		]);
	});

	it("reports scanned PDFs without falling back to host binaries", async () => {
		const root = createWorkspace();
		fs.writeFileSync(path.join(root, "scan.pdf"), "%PDF");
		const extractors: ReadFileExtractors = {
			extractPdfText: async () => "",
			recognizeImage: async () => {
				throw new Error("unexpected OCR");
			},
		};

		let observedError = "";
		try {
			await readLocalFile({
				requestedPath: "./scan.pdf",
				downloadedFiles: [],
				fileWorkspaceRoot: root,
				extractors,
			});
		} catch (error) {
			observedError =
				error instanceof Error ? error.message : String(error);
		}
		assert.include(observedError, "PDF has no extractable text layer");
	});

	it("attempts package-backed OCR for images and surfaces errors cleanly", async () => {
		const root = createWorkspace();
		fs.writeFileSync(path.join(root, "label.png"), "png");
		const extractors: ReadFileExtractors = {
			extractPdfText: async () => {
				throw new Error("unexpected PDF extraction");
			},
			recognizeImage: async (filePath) => {
				assert.strictEqual(
					filePath,
					fs.realpathSync(path.join(root, "label.png")),
				);
				return "Image label";
			},
		};
		const result = await readLocalFile({
			requestedPath: "./label.png",
			downloadedFiles: [],
			fileWorkspaceRoot: root,
			extractors,
		});
		assert.strictEqual(result.method, "image_ocr");
		assert.strictEqual(result.content, "Image label");

		let observedError = "";
		try {
			await readLocalFile({
				requestedPath: "./label.png",
				downloadedFiles: [],
				fileWorkspaceRoot: root,
				extractors: {
					extractPdfText: extractors.extractPdfText,
					recognizeImage: async () => {
						throw new Error("OCR initialization failed");
					},
				},
			});
		} catch (error) {
			observedError =
				error instanceof Error ? error.message : String(error);
		}
		assert.strictEqual(
			observedError,
			"read_file failed for ./label.png: OCR initialization failed",
		);
	});

	it("marks and bounds truncated output", async () => {
		const root = createWorkspace();
		fs.writeFileSync(path.join(root, "long.txt"), "abcdefghij".repeat(20));

		const result = await readLocalFile({
			requestedPath: "./long.txt",
			downloadedFiles: [],
			fileWorkspaceRoot: root,
			maxChars: 60,
		});

		assert.isTrue(result.truncated);
		assert.lengthOf(result.content, 60);
		assert.match(result.content, /\[read_file output truncated\]$/);
	});

	it("converts CSV files to bounded Markdown tables", async () => {
		const root = createWorkspace();
		fs.writeFileSync(
			path.join(root, "scores.csv"),
			'name,description,extra\nAda,"A | B",10\nBob,"She said ""hi"""\n',
		);

		const result = await readLocalFile({
			requestedPath: "./scores.csv",
			downloadedFiles: [],
			fileWorkspaceRoot: root,
			maxChars: 90,
		});

		assert.strictEqual(result.method, "csv_markdown");
		assert.isTrue(result.truncated);
		assert.lengthOf(result.content, 90);
		assert.include(result.content, "| name | description | extra |");
		assert.match(result.content, /\[read_file output truncated\]$/);
	});

	it("reports malformed and empty local conversions cleanly", async () => {
		const root = createWorkspace();
		fs.writeFileSync(path.join(root, "broken.docx"), "not a docx");
		fs.writeFileSync(path.join(root, "empty.csv"), "");

		for (const requestedPath of ["./broken.docx", "./empty.csv"]) {
			let observedError = "";
			try {
				await readLocalFile({
					requestedPath,
					downloadedFiles: [],
					fileWorkspaceRoot: root,
				});
			} catch (error) {
				observedError =
					error instanceof Error ? error.message : String(error);
			}
			assert.match(
				observedError,
				new RegExp(
					`^read_file failed for ${requestedPath.replace(".", "\\.")}:`,
				),
			);
		}
	});
});

describe("read_file CSV conversion", () => {
	it("parses common delimiters, quoted fields, and escaped quotes", () => {
		assert.deepEqual(parseCsvContent('name;note\r\nAda;"A; B"\r\n'), [
			["name", "note"],
			["Ada", "A; B"],
		]);
		assert.deepEqual(parseCsvContent('name\tnote\nAda\t"said ""hi"""\n'), [
			["name", "note"],
			["Ada", 'said "hi"'],
		]);
	});

	it("formats escaped and uneven cells as a Markdown table", () => {
		assert.strictEqual(
			convertCsvContentToMarkdown(
				'name,description,extra\nAda,"A | B",10\nBob,Two\n',
			),
			[
				"| name | description | extra |",
				"| --- | --- | --- |",
				"| Ada | A \\| B | 10 |",
				"| Bob | Two |  |",
			].join("\n"),
		);
	});
});
