import * as fs from "fs";
import * as path from "path";
import type { Browser, Tab } from "../../browser/types.js";
import {
	isPathInsideOrEqual,
	toLogicalDownloadPath,
} from "../../file-workspace.js";
export { estimateTokenCount } from "../prompt-token-estimator.js";

const PRE_STEP_SCREENSHOT_JPEG_QUALITY = 100;

function buildDownloadFileSignature(stats: fs.Stats): string {
	return `${stats.size}:${stats.mtimeMs}`;
}

function isInvisibleName(name: string): boolean {
	return name.startsWith(".");
}

function toRelativeWorkspacePath(
	rootDir: string,
	filePath: string,
): string | null {
	const relativePath = path.relative(rootDir, filePath);
	if (
		!relativePath ||
		relativePath === "." ||
		relativePath.startsWith("..") ||
		path.isAbsolute(relativePath)
	) {
		return null;
	}
	const normalized = relativePath.split(path.sep).join("/");
	return normalized ? `./${normalized}` : null;
}

function isDownloadInProgressFile(fileName: string): boolean {
	return fileName.toLowerCase().endsWith(".crdownload");
}

function collectDownloadFileEntries(
	downloadDir: string,
	excludedRoot?: string,
): Array<{ filePath: string; isDownloading: boolean }> {
	const discovered = new Map<string, boolean>();
	const stack = [downloadDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (isInvisibleName(entry.name)) continue;
			const fullPath = path.join(currentDir, entry.name);
			if (excludedRoot && isPathInsideOrEqual(excludedRoot, fullPath)) {
				continue;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			discovered.set(fullPath, isDownloadInProgressFile(entry.name));
		}
	}

	return [...discovered.entries()]
		.map(([filePath, isDownloading]) => ({ filePath, isDownloading }))
		.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export function buildDownloadedFilesPayload(params: {
	downloadDir?: string;
	fileWorkspaceRoot?: string;
	downloadRootDir?: string;
	previousFileSignatures: Map<string, string> | null;
	previousNewFilePaths: Set<string> | null;
}): {
	downloadedFiles: string[];
	fileSignatures: Map<string, string>;
	newFilePaths: Set<string>;
} {
	const previousSignatures = params.previousFileSignatures;
	const previousNewFilePaths =
		params.previousNewFilePaths ?? new Set<string>();
	const nextNewFilePaths = new Set(previousNewFilePaths);
	const nextSignatures = new Map<string, string>();
	if (!params.downloadDir) {
		return {
			downloadedFiles: [],
			fileSignatures: nextSignatures,
			newFilePaths: nextNewFilePaths,
		};
	}

	const fileEntries = collectDownloadFileEntries(params.downloadDir);
	const downloadedFiles: string[] = [];

	for (const { filePath, isDownloading } of fileEntries) {
		const relativeFilePath = toLogicalDownloadPath({
			filePath,
			roots: {
				downloadDir: params.downloadDir,
				downloadRootDir: params.downloadRootDir,
				fileWorkspaceRoot: params.fileWorkspaceRoot,
			},
		});
		if (!relativeFilePath) {
			continue;
		}
		if (isDownloading) {
			downloadedFiles.push(`[DOWNLOADING] ${relativeFilePath}`);
			continue;
		}

		let stats: fs.Stats;
		try {
			stats = fs.statSync(filePath);
		} catch {
			continue;
		}
		const signature = buildDownloadFileSignature(stats);
		nextSignatures.set(filePath, signature);
		const isNewThisStep =
			previousSignatures !== null &&
			previousSignatures.get(filePath) !== signature;
		if (isNewThisStep) {
			nextNewFilePaths.add(filePath);
		}
		const wasMarkedNewEarlier = nextNewFilePaths.has(filePath);
		downloadedFiles.push(
			wasMarkedNewEarlier
				? `[NEW] ${relativeFilePath}`
				: relativeFilePath,
		);
	}

	return {
		downloadedFiles,
		fileSignatures: nextSignatures,
		newFilePaths: nextNewFilePaths,
	};
}

export function buildWorkspaceFilesPayload(params: {
	fileWorkspaceRoot?: string;
	downloadRootDir?: string;
}): string[] {
	if (!params.fileWorkspaceRoot) {
		return [];
	}
	const excludedDownloadRoot =
		params.downloadRootDir &&
		isPathInsideOrEqual(params.fileWorkspaceRoot, params.downloadRootDir)
			? params.downloadRootDir
			: undefined;
	const fileEntries = collectDownloadFileEntries(
		params.fileWorkspaceRoot,
		excludedDownloadRoot,
	);
	return fileEntries
		.filter(({ isDownloading }) => !isDownloading)
		.map(({ filePath }) =>
			toRelativeWorkspacePath(
				params.fileWorkspaceRoot as string,
				filePath,
			),
		)
		.filter((filePath): filePath is string => Boolean(filePath));
}

export function formatTabTitle(tab: Pick<Tab, "title">): string {
	const title = typeof tab.title === "string" ? tab.title.trim() : "";
	return title || "(untitled)";
}

export function getNewlyOpenedTabs(
	previousTabs: Tab[] | null,
	currentTabs: Tab[],
): Tab[] {
	if (!previousTabs) return [];
	const previousTargetIds = new Set(previousTabs.map((tab) => tab.targetId));
	return currentTabs.filter((tab) => !previousTargetIds.has(tab.targetId));
}

export async function resolveCurrentTabIndex(params: {
	b: Browser;
	openTabs: Tab[];
	currentUrl: string;
}): Promise<number> {
	if (params.openTabs.length === 0) return 0;

	// The Browser connection tracks the exact target whose Page/Runtime domains
	// are currently installed. Chrome can report more than one page as attached,
	// so selecting the first attached target may identify an inactive tab.
	if (params.b.currentTargetId) {
		const index = params.openTabs.findIndex(
			(tab) => tab.targetId === params.b.currentTargetId,
		);
		if (index >= 0) return index;
	}

	try {
		const targetResponse = (await params.b.Target.getTargets()) as {
			targetInfos?: Array<{
				type?: string;
				targetId?: string;
				attached?: boolean;
			}>;
		};
		const attachedPageTarget = targetResponse.targetInfos?.find(
			(info) => info.type === "page" && info.attached,
		);
		if (attachedPageTarget?.targetId) {
			const index = params.openTabs.findIndex(
				(tab) => tab.targetId === attachedPageTarget.targetId,
			);
			if (index >= 0) return index;
		}
	} catch {
		// Fall back to URL matching below if target lookup is unavailable.
	}

	const indexByUrl = params.openTabs.findIndex(
		(tab) => tab.url === params.currentUrl,
	);
	return indexByUrl >= 0 ? indexByUrl : 0;
}

export async function capturePreStepScreenshotDataUrl(params: {
	b: Browser;
	validRefs: string[];
	jpegQuality?: number;
}): Promise<string> {
	void params.validRefs;
	const { data: imageBase64 } = await params.b.Page.captureScreenshot({
		format: "jpeg",
		quality: params.jpegQuality ?? PRE_STEP_SCREENSHOT_JPEG_QUALITY,
		captureBeyondViewport: false,
		fromSurface: true,
	});
	if (!imageBase64.trim()) {
		throw new Error(
			"capturePreStepScreenshotDataUrl received empty screenshot bytes",
		);
	}
	return `data:image/jpeg;base64,${imageBase64}`;
}
