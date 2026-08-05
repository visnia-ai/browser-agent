#!/usr/bin/env bun

import { BROWSER_AGENT_VERSION, RPC_PROTOCOL_VERSION } from "./version.js";

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
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
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

function createDocx(text: string): Buffer {
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

if (process.argv.includes("--version-json")) {
	process.stdout.write(
		`${JSON.stringify({
			version: BROWSER_AGENT_VERSION,
			rpcProtocolVersion: RPC_PROTOCOL_VERSION,
		})}\n`,
	);
} else if (process.argv.includes("--sdk-self-test-json")) {
	const fs = await import("node:fs/promises");
	const os = await import("node:os");
	const path = await import("node:path");
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "browser-agent-self-test-"),
	);
	try {
		const imagePath = path.join(directory, "sample.png");
		const pdfPath = path.join(directory, "sample.pdf");
		const docxPath = path.join(directory, "sample.docx");
		const xlsxPath = path.join(directory, "sample.xlsx");
		const { default: sharp } = await import("sharp");
		await sharp(
			Buffer.from(
				'<svg width="240" height="80"><rect width="100%" height="100%" fill="white"/><text x="20" y="58" font-size="52" fill="black">TEST</text></svg>',
			),
		)
			.png()
			.toFile(imagePath);
		await fs.writeFile(pdfPath, createTextPdf("SDK PDF TEST"));
		await fs.writeFile(docxPath, createDocx("SDK DOCX TEST"));
		const XLSX = await import("xlsx");
		const workbook = XLSX.utils.book_new();
		const worksheet = XLSX.utils.aoa_to_sheet([
			["Name", "Score"],
			["Ada", 10],
		]);
		XLSX.utils.book_append_sheet(workbook, worksheet, "Scores");
		await fs.writeFile(
			xlsxPath,
			XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
		);
		const { readLocalFile } =
			await import("./agents/executor-utils/read-file.js");
		const image = await readLocalFile({
			requestedPath: "./sample.png",
			downloadedFiles: [],
			fileWorkspaceRoot: directory,
		});
		const pdf = await readLocalFile({
			requestedPath: "./sample.pdf",
			downloadedFiles: [],
			fileWorkspaceRoot: directory,
		});
		const docx = await readLocalFile({
			requestedPath: "./sample.docx",
			downloadedFiles: [],
			fileWorkspaceRoot: directory,
		});
		const xlsx = await readLocalFile({
			requestedPath: "./sample.xlsx",
			downloadedFiles: [],
			fileWorkspaceRoot: directory,
		});
		if (!image.content.includes("TEST"))
			throw new Error("OCR self-test failed");
		if (!pdf.content.includes("SDK PDF TEST")) {
			throw new Error("PDF self-test failed");
		}
		if (!docx.content.includes("SDK DOCX TEST")) {
			throw new Error("DOCX self-test failed");
		}
		if (!xlsx.content.includes("Ada") || !xlsx.content.includes("10")) {
			throw new Error("XLSX self-test failed");
		}
		const { estimateTokenCount } =
			await import("./agents/executor-utils/step-context.js");
		if (estimateTokenCount("hello world") !== 2) {
			throw new Error("Tiktoken self-test failed");
		}
		process.stdout.write(
			`${JSON.stringify({
				sharp: true,
				tesseract: true,
				tiktoken: true,
				pdf: true,
				docx: true,
				xlsx: true,
			})}\n`,
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
} else {
	const { runCli } = await import("./cli.js");
	await runCli();
}
