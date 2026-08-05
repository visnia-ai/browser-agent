import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { inflateSync } from "zlib";

export interface VisibilityCheckRecord {
	checkIndex: number;
	nodeIndex: number;
	backendNodeId: number;
	visible: boolean;
	durationMs: number;
	noPaintBounds: boolean;
	screenshotFile: string | null;
}

export interface VisibilityCheckSummary {
	runDir: string;
	candidateCount: number;
	checkedCount: number;
	skippedNoBidCount: number;
	visibleCount: number;
	invisibleCount: number;
	totalDurationMs: number;
	averageDurationMs: number;
	records: VisibilityCheckRecord[];
}

function timestampLabel(date: Date): string {
	const pad2 = (n: number): string => String(n).padStart(2, "0");
	const pad3 = (n: number): string => String(n).padStart(3, "0");
	return [
		date.getFullYear(),
		pad2(date.getMonth() + 1),
		pad2(date.getDate()),
		"-",
		pad2(date.getHours()),
		pad2(date.getMinutes()),
		pad2(date.getSeconds()),
		"-",
		pad3(date.getMilliseconds()),
	].join("");
}

function paethPredictor(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

function getBytesPerPixel(colorType: number): number {
	switch (colorType) {
		case 0:
			return 1; // grayscale
		case 2:
			return 3; // rgb
		case 3:
			return 1; // indexed
		case 4:
			return 2; // grayscale + alpha
		case 6:
			return 4; // rgba
		default:
			throw new Error(`Unsupported PNG colorType=${colorType}`);
	}
}

function decodePngScanlines(pngData: Buffer): {
	width: number;
	height: number;
	colorType: number;
	bitDepth: number;
	reconstructed: Buffer;
	bytesPerPixel: number;
} {
	const pngSignatureHex = "89504e470d0a1a0a";
	if (pngData.length < 8 || pngData.subarray(0, 8).toString("hex") !== pngSignatureHex) {
		throw new Error("Invalid PNG signature");
	}

	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idatParts: Buffer[] = [];

	while (offset + 8 <= pngData.length) {
		const length = pngData.readUInt32BE(offset);
		const type = pngData.subarray(offset + 4, offset + 8).toString("ascii");
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > pngData.length) {
			throw new Error("Corrupted PNG chunk bounds");
		}
		const chunkData = pngData.subarray(dataStart, dataEnd);

		if (type === "IHDR") {
			width = chunkData.readUInt32BE(0);
			height = chunkData.readUInt32BE(4);
			bitDepth = chunkData.readUInt8(8);
			colorType = chunkData.readUInt8(9);
		} else if (type === "IDAT") {
			idatParts.push(chunkData);
		} else if (type === "IEND") {
			break;
		}

		offset = dataEnd + 4; // skip CRC
	}

	if (width <= 0 || height <= 0) {
		return {
			width,
			height,
			colorType,
			bitDepth,
			reconstructed: Buffer.alloc(0),
			bytesPerPixel: 0,
		};
	}
	if (bitDepth !== 8) {
		throw new Error(`Unsupported PNG bitDepth=${bitDepth}. Expected 8.`);
	}

	const bytesPerPixel = getBytesPerPixel(colorType);
	const stride = width * bytesPerPixel;
	const inflated = inflateSync(Buffer.concat(idatParts));
	const expectedMin = height * (1 + stride);
	if (inflated.length < expectedMin) {
		throw new Error(
			`Inflated PNG data too short (${inflated.length} < ${expectedMin})`,
		);
	}

	const reconstructed = Buffer.alloc(height * stride);
	let srcOffset = 0;
	let dstOffset = 0;
	for (let y = 0; y < height; y++) {
		const filterType = inflated[srcOffset++];
		for (let x = 0; x < stride; x++) {
			const raw = inflated[srcOffset++];
			const left = x >= bytesPerPixel ? reconstructed[dstOffset + x - bytesPerPixel] : 0;
			const up = y > 0 ? reconstructed[dstOffset + x - stride] : 0;
			const upLeft =
				y > 0 && x >= bytesPerPixel
					? reconstructed[dstOffset + x - stride - bytesPerPixel]
					: 0;
			let value = raw;
			switch (filterType) {
				case 0:
					value = raw;
					break;
				case 1:
					value = (raw + left) & 0xff;
					break;
				case 2:
					value = (raw + up) & 0xff;
					break;
				case 3:
					value = (raw + Math.floor((left + up) / 2)) & 0xff;
					break;
				case 4:
					value = (raw + paethPredictor(left, up, upLeft)) & 0xff;
					break;
				default:
					throw new Error(`Unsupported PNG filter type=${filterType}`);
			}
			reconstructed[dstOffset + x] = value;
		}
		dstOffset += stride;
	}

	return {
		width,
		height,
		colorType,
		bitDepth,
		reconstructed,
		bytesPerPixel,
	};
}

export function hasAnyNonTransparentPixel(base64Png: string): boolean {
	if (!base64Png || !base64Png.trim()) return false;
	const pngData = Buffer.from(base64Png, "base64");
	const decoded = decodePngScanlines(pngData);
	if (decoded.width <= 0 || decoded.height <= 0) return false;

	// No alpha channel: assume rendered pixels are visible.
	if (decoded.colorType === 0 || decoded.colorType === 2 || decoded.colorType === 3) {
		return decoded.reconstructed.length > 0;
	}

	const alphaOffset = decoded.colorType === 4 ? 1 : 3;
	const bpp = decoded.bytesPerPixel;
	for (let i = alphaOffset; i < decoded.reconstructed.length; i += bpp) {
		if (decoded.reconstructed[i] > 0) return true;
	}
	return false;
}

export function createVisibilityCheckRunDir(baseDir: string): string {
	fs.mkdirSync(baseDir, { recursive: true });
	const label = `${timestampLabel(new Date())}-${crypto.randomBytes(4).toString("hex")}`;
	const runDir = path.join(baseDir, label);
	fs.mkdirSync(runDir, { recursive: true });
	return runDir;
}

export function saveVisibilityCheckScreenshot(params: {
	runDir: string;
	checkIndex: number;
	nodeIndex: number;
	backendNodeId: number;
	visible: boolean;
	imageBase64: string;
}): string {
	const checkLabel = String(params.checkIndex).padStart(4, "0");
	const status = params.visible ? "visible" : "invisible";
	const fileName = `check-${checkLabel}-node-${params.nodeIndex}-backend-${params.backendNodeId}-${status}.png`;
	const filePath = path.join(params.runDir, fileName);
	fs.writeFileSync(filePath, Buffer.from(params.imageBase64, "base64"));
	return filePath;
}

export function writeVisibilityCheckSummary(summary: VisibilityCheckSummary): string {
	const summaryPath = path.join(summary.runDir, "summary.json");
	fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
	return summaryPath;
}
