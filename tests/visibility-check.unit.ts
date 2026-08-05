import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { deflateSync } from "zlib";
import { describe, it } from "mocha";
import {
	createVisibilityCheckRunDir,
	hasAnyNonTransparentPixel,
	saveVisibilityCheckScreenshot,
	writeVisibilityCheckSummary,
} from "../src/browser/simplify-dom-utils/visibility-check.js";

function makeCrc32Table(): Uint32Array {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c >>> 0;
	}
	return table;
}

const CRC32_TABLE = makeCrc32Table();

function crc32(data: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBuffer = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const crcInput = Buffer.concat([typeBuffer, data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(crcInput), 0);
	return Buffer.concat([length, typeBuffer, data, crc]);
}

function make1x1RgbaPngBase64(r: number, g: number, b: number, a: number): string {
	const signature = Buffer.from("89504e470d0a1a0a", "hex");
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0); // width
	ihdr.writeUInt32BE(1, 4); // height
	ihdr.writeUInt8(8, 8); // bit depth
	ihdr.writeUInt8(6, 9); // color type RGBA
	ihdr.writeUInt8(0, 10); // compression
	ihdr.writeUInt8(0, 11); // filter
	ihdr.writeUInt8(0, 12); // interlace
	const rawScanline = Buffer.from([0, r, g, b, a]); // filter=0 + rgba
	const idatData = deflateSync(rawScanline);
	const pngBuffer = Buffer.concat([
		signature,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idatData),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	return pngBuffer.toString("base64");
}

describe("visibility-check utils", () => {
	it("detects no visible pixels for fully transparent screenshot", () => {
		const transparentPng = make1x1RgbaPngBase64(255, 0, 0, 0);
		assert.strictEqual(hasAnyNonTransparentPixel(transparentPng), false);
	});

	it("detects visible pixels when alpha is non-zero", () => {
		const opaquePng = make1x1RgbaPngBase64(255, 0, 0, 255);
		assert.strictEqual(hasAnyNonTransparentPixel(opaquePng), true);
	});

	it("writes screenshot artifacts and summary metadata", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "visibility-check-utils-"),
		);
		try {
			const runDir = createVisibilityCheckRunDir(tmpDir);
			const screenshotPath = saveVisibilityCheckScreenshot({
				runDir,
				checkIndex: 1,
				nodeIndex: 7,
				backendNodeId: 42,
				visible: true,
				imageBase64: make1x1RgbaPngBase64(0, 255, 0, 255),
			});
			assert(fs.existsSync(screenshotPath), "Expected screenshot file.");

			const summaryPath = writeVisibilityCheckSummary({
				runDir,
				candidateCount: 1,
				checkedCount: 1,
				skippedNoBidCount: 0,
				visibleCount: 1,
				invisibleCount: 0,
				totalDurationMs: 5,
				averageDurationMs: 5,
				records: [
					{
						checkIndex: 1,
						nodeIndex: 7,
						backendNodeId: 42,
						visible: true,
						durationMs: 5,
						noPaintBounds: false,
						screenshotFile: screenshotPath,
					},
				],
			});
			assert(fs.existsSync(summaryPath), "Expected summary file.");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
