import { assert } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "mocha";
import yaml from "js-yaml";
import sharp from "sharp";
import * as XLSX from "xlsx";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { readLocalFile } from "../src/agents/executor-utils/read-file.js";

const temporaryDirectories: string[] = [];

function createWorkspace(): string {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "read-file-package-e2e-"),
	);
	temporaryDirectories.push(root);
	return root;
}

function createTextPdf(text: string): Buffer {
	const escaped = text
		.replaceAll("\\", "\\\\")
		.replaceAll("(", "\\(")
		.replaceAll(")", "\\)");
	const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xrefOffset = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n`;
	pdf += "0000000000 65535 f \n";
	for (const offset of offsets.slice(1)) {
		pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(pdf);
}

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let index = 0; index < 8; index += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: Record<string, string>): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;

	for (const [name, contents] of Object.entries(entries)) {
		const nameBuffer = Buffer.from(name);
		const contentsBuffer = Buffer.from(contents);
		const checksum = crc32(contentsBuffer);
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(contentsBuffer.length, 18);
		localHeader.writeUInt32LE(contentsBuffer.length, 22);
		localHeader.writeUInt16LE(nameBuffer.length, 26);
		localParts.push(localHeader, nameBuffer, contentsBuffer);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(contentsBuffer.length, 20);
		centralHeader.writeUInt32LE(contentsBuffer.length, 24);
		centralHeader.writeUInt16LE(nameBuffer.length, 28);
		centralHeader.writeUInt32LE(offset, 42);
		centralParts.push(centralHeader, nameBuffer);
		offset +=
			localHeader.length + nameBuffer.length + contentsBuffer.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
}

function createDocxBuffer(text: string): Buffer {
	return createStoredZip({
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
	<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
	<Default Extension="xml" ContentType="application/xml"/>
	<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
		"_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
	<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
	<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`,
	});
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("read_file package-owned extraction", () => {
	it("extracts a real PDF without any executable available on PATH", async () => {
		const root = createWorkspace();
		fs.writeFileSync(
			path.join(root, "evidence.pdf"),
			createTextPdf("PACKAGE OWNED PDF EVIDENCE"),
		);
		const originalPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const result = await readLocalFile({
				requestedPath: "./evidence.pdf",
				downloadedFiles: [],
				fileWorkspaceRoot: root,
			});
			assert.strictEqual(result.method, "pdf_text");
			assert.include(result.content, "PACKAGE OWNED PDF EVIDENCE");
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("converts DOCX and XLSX locally without executables or network access", async () => {
		const root = createWorkspace();
		fs.writeFileSync(
			path.join(root, "evidence.docx"),
			createDocxBuffer("LOCAL DOCX EVIDENCE"),
		);
		const workbook = XLSX.utils.book_new();
		const worksheet = XLSX.utils.aoa_to_sheet([
			["Name", "Score"],
			["Ada", 10],
		]);
		XLSX.utils.book_append_sheet(workbook, worksheet, "Scores");
		fs.writeFileSync(
			path.join(root, "evidence.xlsx"),
			XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
		);

		const originalPath = process.env.PATH;
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		process.env.PATH = "";
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			throw new Error("network access is disabled");
		}) as typeof fetch;
		try {
			const docxResult = await readLocalFile({
				requestedPath: "./evidence.docx",
				downloadedFiles: [],
				fileWorkspaceRoot: root,
			});
			assert.strictEqual(docxResult.method, "docx_markdown");
			assert.include(docxResult.content, "LOCAL DOCX EVIDENCE");

			const xlsxResult = await readLocalFile({
				requestedPath: "./evidence.xlsx",
				downloadedFiles: [],
				fileWorkspaceRoot: root,
			});
			assert.strictEqual(xlsxResult.method, "xlsx_markdown");
			assert.include(xlsxResult.content, "## Scores");
			assert.include(xlsxResult.content, "Ada");
			assert.include(xlsxResult.content, "10");
			assert.strictEqual(fetchCalls, 0);
		} finally {
			process.env.PATH = originalPath;
			globalThis.fetch = originalFetch;
		}
	});

	it("returns CSV Markdown through the executor result protocol", async () => {
		const root = createWorkspace();
		const memoryFile = path.join(root, "memory.txt");
		const resultMemoryFile = path.join(root, "result-memory.txt");
		fs.writeFileSync(memoryFile, "");
		fs.writeFileSync(resultMemoryFile, "");
		fs.writeFileSync(path.join(root, "scores.csv"), "name,score\nAda,10\n");

		const result = await executeActions({
			b: {
				fileWorkspaceRoot: root,
				downloadDir: root,
			} as never,
			actions: [
				{ type: "read_file", path: "./scores.csv" },
				{ type: "return_results" },
			],
			openTabs: [],
			memoryFile,
			extractDataMemoryFile: resultMemoryFile,
			workspaceFiles: ["./scores.csv"],
			fileWorkspaceRoot: root,
		});

		assert.isTrue(result.pendingMemoryRead);
		assert.deepEqual(yaml.load(result.returnedResult ?? ""), [
			{
				link: "file:./scores.csv",
				summary: [
					"| name | score |",
					"| --- | --- |",
					"| Ada | 10 |",
				].join("\n"),
			},
		]);
		assert.include(
			result.toolObservations.join("\n"),
			"using csv_markdown",
		);
	});

	it("OCRs an image and returns it through the executor result protocol", async () => {
		const root = createWorkspace();
		const imagePath = path.join(root, "evidence.png");
		const memoryFile = path.join(root, "memory.txt");
		const resultMemoryFile = path.join(root, "result-memory.txt");
		fs.writeFileSync(memoryFile, "");
		fs.writeFileSync(resultMemoryFile, "");
		await sharp({
			create: {
				width: 1400,
				height: 300,
				channels: 3,
				background: "white",
			},
		})
			.composite([
				{
					input: Buffer.from(
						'<svg width="1400" height="300"><text x="55" y="185" font-family="Arial" font-size="96" fill="black">PACKAGE OCR 4729</text></svg>',
					),
				},
			])
			.png()
			.toFile(imagePath);

		const originalPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const result = await executeActions({
				b: {
					fileWorkspaceRoot: root,
					downloadDir: root,
				} as never,
				actions: [
					{ type: "read_file", path: "./evidence.png" },
					{ type: "return_results" },
				],
				openTabs: [],
				memoryFile,
				extractDataMemoryFile: resultMemoryFile,
				workspaceFiles: ["./evidence.png"],
				fileWorkspaceRoot: root,
			});
			assert.isTrue(result.pendingMemoryRead);
			assert.deepEqual(yaml.load(result.returnedResult ?? ""), [
				{
					link: "file:./evidence.png",
					summary: "PACKAGE OCR 4729",
				},
			]);
			assert.include(
				result.toolObservations.join("\n"),
				"using image_ocr",
			);
		} finally {
			process.env.PATH = originalPath;
		}
	});
});
