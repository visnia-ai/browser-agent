import * as fs from "node:fs";
import * as path from "node:path";

export interface FileWorkspaceRoots {
	fileWorkspaceRoot?: string;
	downloadDir?: string;
	downloadRootDir?: string;
}

export interface ResolvedLocalFile {
	logicalPath: string;
	resolvedPath: string;
	source: "workspace" | "download";
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		Boolean(relative) &&
		relative !== "." &&
		!relative.startsWith("..") &&
		!path.isAbsolute(relative)
	);
}

function isInsideOrEqual(root: string, candidate: string): boolean {
	return (
		path.resolve(root) === path.resolve(candidate) ||
		isInside(root, candidate)
	);
}

function toLogicalPath(segments: string[]): string {
	return `./${segments.join("/")}`;
}

export function validateLogicalFilePath(requestedPath: string): string {
	const normalized = requestedPath.trim();
	if (!normalized) {
		throw new Error('file path requires a non-empty "path"');
	}
	if (
		path.isAbsolute(normalized) ||
		path.win32.isAbsolute(normalized) ||
		!normalized.startsWith("./")
	) {
		throw new Error(
			'file path must use the workspace-relative "./..." form',
		);
	}
	if (normalized.includes("\\")) {
		throw new Error("file path must use forward slashes");
	}
	const segments = normalized.slice(2).split("/");
	if (
		segments.length === 0 ||
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				segment.startsWith("."),
		)
	) {
		throw new Error(
			"file path may not contain traversal or hidden path segments",
		);
	}
	return toLogicalPath(segments);
}

export function getWorkspaceDownloadMount(
	roots: FileWorkspaceRoots,
): string[] | null {
	if (!roots.fileWorkspaceRoot || !roots.downloadRootDir) return null;
	const workspaceRoot = path.resolve(roots.fileWorkspaceRoot);
	const downloadRoot = path.resolve(roots.downloadRootDir);
	if (!isInsideOrEqual(workspaceRoot, downloadRoot)) return null;
	const relative = path.relative(workspaceRoot, downloadRoot);
	return relative ? relative.split(path.sep) : [];
}

function resolveExistingFile(root: string, segments: string[]): string | null {
	const resolvedRoot = path.resolve(root);
	const candidate = path.resolve(resolvedRoot, ...segments);
	if (!isInside(resolvedRoot, candidate)) return null;
	try {
		const realRoot = fs.realpathSync(resolvedRoot);
		const realCandidate = fs.realpathSync(candidate);
		if (!isInside(realRoot, realCandidate)) return null;
		return fs.statSync(realCandidate).isFile() ? realCandidate : null;
	} catch {
		return null;
	}
}

function startsWithSegments(value: string[], prefix: string[]): boolean {
	return prefix.every((segment, index) => value[index] === segment);
}

function isWorkspaceDownloadPath(
	workspaceRoot: string,
	downloadRootDir: string | undefined,
	candidate: string,
): boolean {
	if (!downloadRootDir) return false;
	const resolvedWorkspace = path.resolve(workspaceRoot);
	const resolvedDownloadRoot = path.resolve(downloadRootDir);
	if (!isInsideOrEqual(resolvedWorkspace, resolvedDownloadRoot)) return false;
	if (isInsideOrEqual(resolvedDownloadRoot, candidate)) return true;
	try {
		const realWorkspace = fs.realpathSync(resolvedWorkspace);
		const realDownloadRoot = fs.realpathSync(resolvedDownloadRoot);
		const realCandidate = fs.realpathSync(candidate);
		return (
			isInsideOrEqual(realWorkspace, realDownloadRoot) &&
			isInsideOrEqual(realDownloadRoot, realCandidate)
		);
	} catch {
		return false;
	}
}

export function resolveLocalFile(params: {
	requestedPath: string;
	roots: FileWorkspaceRoots;
	allowExternalDownload?: boolean;
}): ResolvedLocalFile {
	const logicalPath = validateLogicalFilePath(params.requestedPath);
	const segments = logicalPath.slice(2).split("/");
	const downloadMount = getWorkspaceDownloadMount(params.roots);

	if (
		downloadMount &&
		params.roots.downloadDir &&
		startsWithSegments(segments, downloadMount) &&
		segments.length > downloadMount.length
	) {
		const resolvedPath = resolveExistingFile(
			params.roots.downloadDir,
			segments.slice(downloadMount.length),
		);
		if (resolvedPath) {
			return { logicalPath, resolvedPath, source: "download" };
		}
		throw new Error(`file path is unavailable: ${logicalPath}`);
	}

	if (params.roots.fileWorkspaceRoot) {
		const workspaceRoot = path.resolve(params.roots.fileWorkspaceRoot);
		const lexicalCandidate = path.resolve(workspaceRoot, ...segments);
		if (
			!isWorkspaceDownloadPath(
				workspaceRoot,
				params.roots.downloadRootDir,
				lexicalCandidate,
			)
		) {
			const resolvedPath = resolveExistingFile(workspaceRoot, segments);
			if (
				resolvedPath &&
				!isWorkspaceDownloadPath(
					workspaceRoot,
					params.roots.downloadRootDir,
					resolvedPath,
				)
			) {
				return { logicalPath, resolvedPath, source: "workspace" };
			}
		}
	}

	if (params.allowExternalDownload && params.roots.downloadDir) {
		const resolvedPath = resolveExistingFile(
			params.roots.downloadDir,
			segments,
		);
		if (resolvedPath) {
			return { logicalPath, resolvedPath, source: "download" };
		}
	}

	throw new Error(`file path is unavailable: ${logicalPath}`);
}

export function toLogicalDownloadPath(params: {
	filePath: string;
	roots: FileWorkspaceRoots & { downloadDir: string };
}): string | null {
	const relative = path.relative(params.roots.downloadDir, params.filePath);
	if (
		!relative ||
		relative === "." ||
		relative.startsWith("..") ||
		path.isAbsolute(relative)
	) {
		return null;
	}
	const relativeSegments = relative.split(path.sep);
	const mount = getWorkspaceDownloadMount(params.roots);
	return toLogicalPath([...(mount ?? []), ...relativeSegments]);
}

export function isPathInsideOrEqual(root: string, candidate: string): boolean {
	return isInsideOrEqual(path.resolve(root), path.resolve(candidate));
}
