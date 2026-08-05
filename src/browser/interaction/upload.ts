import * as fs from "fs";
import * as path from "path";
import type { Browser } from "../types.js";
import { isPathInsideOrEqual, resolveLocalFile } from "../../file-workspace.js";
import { click } from "./click.js";
import {
	isStaleNodeErrorMessage,
	resolveElement,
	sleep,
	splitRefCandidates,
	toErrorMessage,
} from "./utils.js";

const FILE_CHOOSER_TIMEOUT_MS = 5_000;
const AUTO_UPLOAD_FILE_CHOOSER_TIMEOUT_MS = 250;
const DOWNLOADS_DIRECTORY_NAME = "downloads";

interface FileChooserOpenedEvent {
	backendNodeId?: number;
}

class FileChooserTimeoutError extends Error {
	constructor() {
		super("Timed out waiting for the page file chooser to open");
		this.name = "FileChooserTimeoutError";
	}
}

function resolveUploadFilePaths(params: {
	fileWorkspaceRoot: string;
	downloadDir?: string;
	downloadRootDir?: string;
	paths: string[];
}): string[] {
	const resolvedPaths: string[] = [];

	for (const rawPath of params.paths) {
		if (typeof rawPath !== "string" || !rawPath.trim()) {
			throw new Error(
				'upload_files requires non-empty string entries in "paths"',
			);
		}

		try {
			resolvedPaths.push(
				resolveLocalFile({
					requestedPath: rawPath,
					roots: {
						fileWorkspaceRoot: params.fileWorkspaceRoot,
						downloadDir: params.downloadDir,
						downloadRootDir: params.downloadRootDir,
					},
				}).resolvedPath,
			);
		} catch (error) {
			throw new Error(
				`upload_files ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return resolvedPaths;
}

function collectAutoUploadFilePaths(
	fileWorkspaceRoot: string,
	downloadRootDir?: string,
): string[] {
	const workspaceRoot = path.resolve(fileWorkspaceRoot);
	const resolvedPaths: string[] = [];

	const visit = (dir: string, isRoot = false): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) {
				continue;
			}
			if (
				entry.isDirectory() &&
				isRoot &&
				entry.name === DOWNLOADS_DIRECTORY_NAME
			) {
				continue;
			}

			const entryPath = path.join(dir, entry.name);
			if (
				downloadRootDir &&
				isPathInsideOrEqual(downloadRootDir, entryPath)
			) {
				continue;
			}
			if (entry.isDirectory()) {
				visit(entryPath);
			} else if (entry.isFile()) {
				resolvedPaths.push(entryPath);
			}
		}
	};

	visit(workspaceRoot, true);
	return resolvedPaths.sort((a, b) => a.localeCompare(b));
}

async function isFileInputElement(params: {
	browser: Browser;
	objectId: string;
}): Promise<boolean> {
	const { result } = await params.browser.Runtime.callFunctionOn({
		objectId: params.objectId,
		functionDeclaration: `function() {
      return this instanceof HTMLInputElement && this.type === "file";
    }`,
		returnByValue: true,
	});
	return Boolean(result.value);
}

async function dispatchFileInputEvents(params: {
	browser: Browser;
	objectId: string;
}): Promise<void> {
	await params.browser.Runtime.callFunctionOn({
		objectId: params.objectId,
		functionDeclaration: `function() {
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }`,
	});
}

async function setFilesOnResolvedInput(params: {
	browser: Browser;
	ref: string;
	resolvedPaths: string[];
}): Promise<void> {
	let nodeContext = await resolveElement(params.browser, params.ref);

	const applyFiles = async (): Promise<void> => {
		await params.browser.DOM.setFileInputFiles({
			nodeId: nodeContext.nodeId,
			files: params.resolvedPaths,
		});
		await dispatchFileInputEvents({
			browser: params.browser,
			objectId: nodeContext.objectId,
		});
	};

	try {
		await applyFiles();
	} catch (error) {
		if (!isStaleNodeErrorMessage(toErrorMessage(error))) {
			throw error;
		}
		nodeContext = await resolveElement(params.browser, params.ref);
		await applyFiles();
	}

	await sleep(100);
}

function waitForFileChooserOpened(browser: Browser): {
	promise: Promise<FileChooserOpenedEvent | undefined>;
	cleanup: () => void;
};
function waitForFileChooserOpened(
	browser: Browser,
	timeoutMs: number,
): {
	promise: Promise<FileChooserOpenedEvent | undefined>;
	cleanup: () => void;
};
function waitForFileChooserOpened(
	browser: Browser,
	timeoutMs = FILE_CHOOSER_TIMEOUT_MS,
): {
	promise: Promise<FileChooserOpenedEvent | undefined>;
	cleanup: () => void;
} {
	const emitter = browser.client as unknown as {
		on: (eventName: string, listener: (event: unknown) => void) => void;
		removeListener: (
			eventName: string,
			listener: (event: unknown) => void,
		) => void;
	};

	let settled = false;
	let timeout: NodeJS.Timeout | undefined;
	const listener = (event: unknown) => {
		if (settled) return;
		settled = true;
		if (timeout) clearTimeout(timeout);
		emitter.removeListener("Page.fileChooserOpened", listener);
		resolvePromise(event as FileChooserOpenedEvent);
	};

	let resolvePromise!: (event: FileChooserOpenedEvent | undefined) => void;
	const promise = new Promise<FileChooserOpenedEvent | undefined>(
		(resolve) => {
			resolvePromise = resolve;
			timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				emitter.removeListener("Page.fileChooserOpened", listener);
				resolve(undefined);
			}, timeoutMs);
		},
	);

	emitter.on("Page.fileChooserOpened", listener);

	return {
		promise,
		cleanup: () => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			emitter.removeListener("Page.fileChooserOpened", listener);
		},
	};
}

async function setFilesOnChooser(params: {
	browser: Browser;
	backendNodeId: number;
	resolvedPaths: string[];
}): Promise<void> {
	await params.browser.DOM.setFileInputFiles({
		backendNodeId: params.backendNodeId,
		files: params.resolvedPaths,
	});
	await sleep(100);
}

async function uploadFilesToCandidate(params: {
	browser: Browser;
	ref: string;
	resolvedPaths: string[];
}): Promise<void> {
	const nodeContext = await resolveElement(params.browser, params.ref);
	if (
		await isFileInputElement({
			browser: params.browser,
			objectId: nodeContext.objectId,
		})
	) {
		await setFilesOnResolvedInput({
			browser: params.browser,
			ref: params.ref,
			resolvedPaths: params.resolvedPaths,
		});
		return;
	}

	await params.browser.Page.setInterceptFileChooserDialog({ enabled: true });
	const waiter = waitForFileChooserOpened(params.browser);
	try {
		await click(params.browser, params.ref);
		const chooserOpened = await waiter.promise;
		if (!chooserOpened) {
			throw new FileChooserTimeoutError();
		}
		if (typeof chooserOpened.backendNodeId !== "number") {
			throw new Error(
				`File chooser opened for ref=${params.ref} without a backendNodeId`,
			);
		}
		await setFilesOnChooser({
			browser: params.browser,
			backendNodeId: chooserOpened.backendNodeId,
			resolvedPaths: params.resolvedPaths,
		});
	} finally {
		waiter.cleanup();
		try {
			await params.browser.Page.setInterceptFileChooserDialog({
				enabled: false,
			});
		} catch {
			// Best-effort cleanup.
		}
	}
}

export async function clickAndAutoUploadIfFileChooser(params: {
	browser: Browser;
	ref: string;
	fileWorkspaceRoot?: string;
}): Promise<{ fileChooserOpened: boolean; uploadedPaths: string[] }> {
	await params.browser.Page.setInterceptFileChooserDialog({
		enabled: true,
		cancel: true,
	} as { enabled: boolean; cancel: boolean });
	const waiter = waitForFileChooserOpened(
		params.browser,
		AUTO_UPLOAD_FILE_CHOOSER_TIMEOUT_MS,
	);
	try {
		await click(params.browser, params.ref);
		const chooserOpened = await waiter.promise;
		if (!chooserOpened) {
			return { fileChooserOpened: false, uploadedPaths: [] };
		}

		if (typeof chooserOpened.backendNodeId !== "number") {
			throw new Error(
				`File chooser opened for ref=${params.ref} without a backendNodeId`,
			);
		}
		if (!params.fileWorkspaceRoot?.trim()) {
			throw new Error(
				"File chooser opened, but this browser session has no file workspace root for automatic upload",
			);
		}

		const uploadPaths = collectAutoUploadFilePaths(
			params.fileWorkspaceRoot,
			params.browser.downloadRootDir,
		);
		if (uploadPaths.length !== 1) {
			throw new Error(
				`File chooser opened, but automatic upload requires exactly one workspace file; found ${uploadPaths.length}`,
			);
		}

		await setFilesOnChooser({
			browser: params.browser,
			backendNodeId: chooserOpened.backendNodeId,
			resolvedPaths: uploadPaths,
		});
		return { fileChooserOpened: true, uploadedPaths: uploadPaths };
	} finally {
		waiter.cleanup();
		try {
			await params.browser.Page.setInterceptFileChooserDialog({
				enabled: false,
			});
		} catch {
			// Best-effort cleanup.
		}
	}
}

export async function uploadFiles(params: {
	browser: Browser;
	ref: string;
	paths: string[];
	fileWorkspaceRoot: string;
}): Promise<void> {
	const resolvedPaths = resolveUploadFilePaths({
		fileWorkspaceRoot: params.fileWorkspaceRoot,
		downloadDir: params.browser.downloadDir,
		downloadRootDir: params.browser.downloadRootDir,
		paths: params.paths,
	});
	const candidates = splitRefCandidates(params.ref);
	const attemptErrors: string[] = [];

	for (const candidateRef of candidates) {
		try {
			await uploadFilesToCandidate({
				browser: params.browser,
				ref: candidateRef,
				resolvedPaths,
			});
			return;
		} catch (error) {
			attemptErrors.push(`${candidateRef}: ${toErrorMessage(error)}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	throw new Error(`Failed to upload files to ref=${params.ref}: ${summary}`);
}
