import * as path from "node:path";
import type { Browser } from "../types.js";
import { resolveLocalFile } from "../../file-workspace.js";
import { getSemanticProjection } from "../semantic-projection.js";
import {
	getSemanticRefTargets,
	type SemanticRefTarget,
} from "../semantic-ref-registry.js";
import { click } from "./click.js";
import { switchTab } from "./tabs.js";
import {
	isStaleNodeErrorMessage,
	resolveElement,
	sleep,
	splitRefCandidates,
	toErrorMessage,
} from "./utils.js";

const FILE_CHOOSER_TIMEOUT_MS = 5_000;
const CLICK_FILE_CHOOSER_GUARD_MS = 250;
const WEB_PICKER_POLL_MS = 100;
const UPLOAD_EVIDENCE_TIMEOUT_MS = 2_000;
const UPLOAD_EVIDENCE_POLL_MS = 200;
const INTERMEDIATE_CONTROL_NAME =
	/^(?:browse|choose files?|select files?|upload from computer)$/i;

interface FileChooserOpenedEvent {
	backendNodeId?: number;
}

interface BrowserTargetInfo {
	targetId: string;
	type: string;
	url: string;
	title: string;
}

interface UploadApplicationResult {
	method: "direct_input" | "native_chooser" | "intermediate_web_picker";
}

export interface UploadFilesResult {
	state: "selected" | "uploading" | "committed";
	paths: string[];
	evidence: string;
}

class FileChooserTimeoutError extends Error {
	constructor(message = "Timed out waiting for the page file chooser to open") {
		super(message);
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
	let resolvePromise!: (event: FileChooserOpenedEvent | undefined) => void;
	const listener = (event: unknown) => {
		if (settled) return;
		settled = true;
		if (timeout) clearTimeout(timeout);
		emitter.removeListener("Page.fileChooserOpened", listener);
		resolvePromise(event as FileChooserOpenedEvent);
	};

	const promise = new Promise<FileChooserOpenedEvent | undefined>((resolve) => {
		resolvePromise = resolve;
		timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			emitter.removeListener("Page.fileChooserOpened", listener);
			resolve(undefined);
		}, timeoutMs);
	});

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
}

function semanticTargetIdentity(target: SemanticRefTarget): string {
	return JSON.stringify([
		target.role,
		target.name ?? "",
		target.ancestorSignature ?? [],
		target.frameId ?? "",
	]);
}

function isInsideDialog(target: SemanticRefTarget): boolean {
	return (target.ancestorSignature ?? []).some(
		(segment) => segment === "dialog" || segment.startsWith("dialog("),
	);
}

function isIntermediateControl(target: SemanticRefTarget): boolean {
	return (
		Boolean(target.name && INTERMEDIATE_CONTROL_NAME.test(target.name.trim())) &&
		target.capabilities.includes("click") &&
		isInsideDialog(target)
	);
}

function describeDialogControls(browser: Browser): string[] {
	return getSemanticRefTargets(browser)
		.filter(
			(target) =>
				isInsideDialog(target) &&
				Boolean(target.name) &&
				target.capabilities.includes("click"),
		)
		.map((target) => `${target.role} ${JSON.stringify(target.name)}`)
		.slice(0, 12);
}

function findNewIntermediateControls(params: {
	browser: Browser;
	baselineIdentities: Set<string>;
}): SemanticRefTarget[] {
	return getSemanticRefTargets(params.browser).filter(
		(target) =>
			isIntermediateControl(target) &&
			!params.baselineIdentities.has(semanticTargetIdentity(target)),
	);
}

async function getBrowserTargetInfos(
	browser: Browser,
): Promise<BrowserTargetInfo[]> {
	try {
		const response = await browser.Target.getTargets();
		return response.targetInfos.map((target) => ({
			targetId: target.targetId,
			type: target.type,
			url: target.url,
			title: target.title,
		}));
	} catch {
		return [];
	}
}

async function getChildFrameIds(browser: Browser): Promise<string[]> {
	try {
		const { frameTree } = await browser.Page.getFrameTree();
		const frameIds: string[] = [];
		const visit = (node: typeof frameTree): void => {
			for (const child of node.childFrames ?? []) {
				frameIds.push(child.frame.id);
				visit(child);
			}
		};
		visit(frameTree);
		return frameIds;
	} catch {
		return [];
	}
}

async function getCurrentTargetId(browser: Browser): Promise<string | undefined> {
	if (browser.currentTargetId) return browser.currentTargetId;
	try {
		const response = await browser.Target.getTargetInfo();
		return response.targetInfo.targetId;
	} catch {
		return undefined;
	}
}

function selectNewPickerTarget(params: {
	targets: BrowserTargetInfo[];
	baselineTargetIds: Set<string>;
}): BrowserTargetInfo | undefined {
	const newPages = params.targets.filter(
		(target) =>
			target.type === "page" &&
			!params.baselineTargetIds.has(target.targetId),
	);
	if (newPages.length === 1) return newPages[0];
	const pickerPages = newPages.filter(
		(target) =>
			/\/picker(?:[/?#]|$)/i.test(target.url) ||
			/(?:onepick|file picker|insert file)/i.test(target.title),
	);
	return pickerPages.length === 1 ? pickerPages[0] : undefined;
}

async function refreshIntermediateControl(params: {
	browser: Browser;
	baselineIdentities: Set<string>;
	frameId?: string;
}): Promise<SemanticRefTarget> {
	await getSemanticProjection(params.browser, { frameId: params.frameId });
	const candidates = findNewIntermediateControls(params);
	if (candidates.length !== 1) {
		throw new Error(
			`Intermediate web picker control became stale and could not be relocated unambiguously; candidates=${candidates.length}; controls seen: ${describeDialogControls(params.browser).join(", ") || "none"}`,
		);
	}
	return candidates[0];
}

async function clickIntermediateAndWaitForChooser(params: {
	browser: Browser;
	control: SemanticRefTarget;
	baselineIdentities: Set<string>;
}): Promise<FileChooserOpenedEvent> {
	let control = params.control;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const waiter = waitForFileChooserOpened(params.browser);
		try {
			try {
				await click(params.browser, control.ref);
			} catch (error) {
				if (
					attempt === 0 &&
					isStaleNodeErrorMessage(toErrorMessage(error))
				) {
					waiter.cleanup();
					control = await refreshIntermediateControl({
						...params,
						frameId: control.frameId,
					});
					continue;
				}
				throw error;
			}

			const chooserOpened = await waiter.promise;
			if (!chooserOpened) {
				throw new FileChooserTimeoutError(
					`Intermediate web picker control ${JSON.stringify(control.name)} did not open a native file chooser`,
				);
			}
			return chooserOpened;
		} finally {
			waiter.cleanup();
		}
	}
	throw new Error("Intermediate web picker control could not be activated");
}

async function uploadFilesToCandidate(params: {
	browser: Browser;
	ref: string;
	resolvedPaths: string[];
}): Promise<UploadApplicationResult> {
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
		return { method: "direct_input" };
	}

	const baselineIdentities = new Set(
		getSemanticRefTargets(params.browser).map(semanticTargetIdentity),
	);
	const baselineTargets = await getBrowserTargetInfos(params.browser);
	const baselineTargetIds = new Set(
		baselineTargets.map((target) => target.targetId),
	);
	const originTargetId = await getCurrentTargetId(params.browser);
	if (originTargetId) baselineTargetIds.add(originTargetId);

	const interceptPages: Browser["Page"][] = [];
	const enableChooserInterception = async (): Promise<void> => {
		await params.browser.Page.setInterceptFileChooserDialog({ enabled: true });
		interceptPages.push(params.browser.Page);
	};
	await enableChooserInterception();
	const initialWaiter = waitForFileChooserOpened(params.browser);
	let initialChooser: FileChooserOpenedEvent | null | undefined;
	void initialWaiter.promise.then((event) => {
		initialChooser = event ?? null;
	});
	let switchedToPicker = false;
	let controlsSeen: string[] = [];

	try {
		await click(params.browser, params.ref);
		const deadline = Date.now() + FILE_CHOOSER_TIMEOUT_MS;
		let intermediateControl: SemanticRefTarget | undefined;

		while (Date.now() < deadline) {
			if (initialChooser) {
				if (typeof initialChooser.backendNodeId !== "number") {
					throw new Error(
						`File chooser opened for ref=${params.ref} without a backendNodeId`,
					);
				}
				await setFilesOnChooser({
					browser: params.browser,
					backendNodeId: initialChooser.backendNodeId,
					resolvedPaths: params.resolvedPaths,
				});
				return { method: "native_chooser" };
			}

			if (!switchedToPicker) {
				const pickerTarget = selectNewPickerTarget({
					targets: await getBrowserTargetInfos(params.browser),
					baselineTargetIds,
				});
				if (pickerTarget) {
					if (!originTargetId) {
						throw new Error(
							`Intermediate web picker opened in target ${pickerTarget.targetId}, but the originating target could not be identified`,
						);
					}
					initialWaiter.cleanup();
					await switchTab(params.browser, pickerTarget.targetId);
					switchedToPicker = true;
					await enableChooserInterception();
				}
			}

			try {
				await getSemanticProjection(params.browser);
				let candidates = findNewIntermediateControls({
					browser: params.browser,
					baselineIdentities,
				});
				controlsSeen = describeDialogControls(params.browser);
				const mainFrameCandidates = candidates;
				const frameCandidateGroups: Array<{
					frameId: string;
					candidates: SemanticRefTarget[];
				}> = [];
				for (const frameId of await getChildFrameIds(params.browser)) {
					await getSemanticProjection(params.browser, { frameId });
					const frameCandidates = findNewIntermediateControls({
						browser: params.browser,
						baselineIdentities,
					});
					controlsSeen = [
						...new Set([
							...controlsSeen,
							...describeDialogControls(params.browser),
						]),
					];
					if (frameCandidates.length > 0) {
						frameCandidateGroups.push({ frameId, candidates: frameCandidates });
					}
				}
				const totalCandidateCount =
					mainFrameCandidates.length +
					frameCandidateGroups.reduce(
						(sum, group) => sum + group.candidates.length,
						0,
					);
				if (totalCandidateCount === 1 && mainFrameCandidates.length === 1) {
					await getSemanticProjection(params.browser);
					candidates = findNewIntermediateControls({
						browser: params.browser,
						baselineIdentities,
					});
				} else if (
					totalCandidateCount === 1 &&
					frameCandidateGroups.length === 1
				) {
					await getSemanticProjection(params.browser, {
						frameId: frameCandidateGroups[0].frameId,
					});
					candidates = findNewIntermediateControls({
						browser: params.browser,
						baselineIdentities,
					});
				} else if (totalCandidateCount > 1) {
					const descriptions = [
						...mainFrameCandidates,
						...frameCandidateGroups.flatMap((group) => group.candidates),
					].map(
						(target) => `${target.role} ${JSON.stringify(target.name)}`,
					);
					throw new Error(
						`Intermediate web picker is ambiguous; matching controls: ${descriptions.join(", ")}`,
					);
				} else {
					candidates = [];
				}
				if (candidates.length === 1) {
					intermediateControl = candidates[0];
					break;
				}
				if (candidates.length > 1) {
					throw new Error(
						`Intermediate web picker is ambiguous; matching controls: ${candidates.map((target) => `${target.role} ${JSON.stringify(target.name)}`).join(", ")}`,
					);
				}
			} catch (error) {
				if (
					toErrorMessage(error).startsWith(
						"Intermediate web picker is ambiguous",
					)
				) {
					throw error;
				}
				// The picker target may still be loading. Retry until the bound expires.
			}
			await sleep(WEB_PICKER_POLL_MS);
		}

		if (!intermediateControl) {
			throw new FileChooserTimeoutError(
				`No supported one-hop intermediate web picker control appeared for ref=${params.ref}; controls seen: ${controlsSeen.join(", ") || "none"}`,
			);
		}

		initialWaiter.cleanup();
		const chooserOpened = await clickIntermediateAndWaitForChooser({
			browser: params.browser,
			control: intermediateControl,
			baselineIdentities,
		});
		if (typeof chooserOpened.backendNodeId !== "number") {
			throw new Error(
				`File chooser opened from intermediate control ${JSON.stringify(intermediateControl.name)} without a backendNodeId`,
			);
		}
		await setFilesOnChooser({
			browser: params.browser,
			backendNodeId: chooserOpened.backendNodeId,
			resolvedPaths: params.resolvedPaths,
		});
		return { method: "intermediate_web_picker" };
	} finally {
		initialWaiter.cleanup();
		for (const page of interceptPages) {
			try {
				await page.setInterceptFileChooserDialog({ enabled: false });
			} catch {
				// Best-effort cleanup for targets that closed after selection.
			}
		}
		if (switchedToPicker && originTargetId) {
			try {
				await switchTab(params.browser, originTargetId);
			} catch (error) {
				throw new Error(
					`The intermediate picker opened, but the originating page could not be restored: ${toErrorMessage(error)}`,
				);
			}
		}
		try {
			await getSemanticProjection(params.browser);
		} catch {
			// The next step will surface navigation/target failures normally.
		}
	}
}

function classifyUploadProjection(params: {
	projection: string;
	fileNames: string[];
	baselineContainedAllNames: boolean;
	method: UploadApplicationResult["method"];
}): UploadFilesResult["state"] {
	const lowerProjection = params.projection.toLowerCase();
	const allNamesVisible = params.fileNames.every((name) =>
		lowerProjection.includes(name.toLowerCase()),
	);
	const showsUploadProgress =
		(allNamesVisible && /\bprogressbar\b/i.test(params.projection)) ||
		(allNamesVisible && /\b(?:uploading|processing)\b/i.test(params.projection));
	if (showsUploadProgress) return "uploading";
	const hasExplicitCompletionEvidence =
		/(?:\b(?:upload complete|uploads complete|uploaded|attached|committed)\b|selected:)/i.test(
			params.projection,
		);
	return allNamesVisible &&
		(params.method === "direct_input" ||
			!params.baselineContainedAllNames ||
			hasExplicitCompletionEvidence)
		? "committed"
		: "selected";
}

async function observeUploadState(params: {
	browser: Browser;
	requestedPaths: string[];
	method: UploadApplicationResult["method"];
	baselineContainedAllNames: boolean;
}): Promise<UploadFilesResult> {
	const fileNames = params.requestedPaths.map((entry) => path.basename(entry));
	if (!(params.browser as Partial<Browser>).Accessibility) {
		return {
			state: "selected",
			paths: params.requestedPaths,
			evidence: `Files were applied through ${params.method}.`,
		};
	}

	const deadline = Date.now() + UPLOAD_EVIDENCE_TIMEOUT_MS;
	let lastState: UploadFilesResult["state"] = "selected";
	while (Date.now() < deadline) {
		try {
			const projection = await getSemanticProjection(params.browser);
			lastState = classifyUploadProjection({
				projection,
				fileNames,
				baselineContainedAllNames: params.baselineContainedAllNames,
				method: params.method,
			});
			if (lastState === "committed") {
				return {
					state: lastState,
					paths: params.requestedPaths,
					evidence:
						"The current semantic projection visibly contains every selected file name and no active upload progress.",
				};
			}
		} catch {
			// Selection itself succeeded; projection evidence is best effort.
			break;
		}
		await sleep(UPLOAD_EVIDENCE_POLL_MS);
	}

	return {
		state: lastState,
		paths: params.requestedPaths,
		evidence:
			lastState === "uploading"
				? "The current semantic projection shows active upload progress."
				: `Files were applied through ${params.method}; the page has not exposed completion evidence yet.`,
	};
}

export async function clickWithFileChooserGuard(params: {
	browser: Browser;
	ref: string;
}): Promise<void> {
	await params.browser.Page.setInterceptFileChooserDialog({
		enabled: true,
		cancel: true,
	} as { enabled: boolean; cancel: boolean });
	const waiter = waitForFileChooserOpened(
		params.browser,
		CLICK_FILE_CHOOSER_GUARD_MS,
	);
	try {
		await click(params.browser, params.ref);
		const chooserOpened = await waiter.promise;
		if (chooserOpened) {
			throw new Error(
				"Plain click opened a native file chooser, which was canceled. Use upload_files with the upload control ref and exact safe path(s).",
			);
		}
	} finally {
		waiter.cleanup();
		try {
			await params.browser.Page.setInterceptFileChooserDialog({ enabled: false });
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
}): Promise<UploadFilesResult> {
	const requestedPaths = [...params.paths];
	const requestedFileNames = requestedPaths.map((entry) => path.basename(entry));
	const resolvedPaths = resolveUploadFilePaths({
		fileWorkspaceRoot: params.fileWorkspaceRoot,
		downloadDir: params.browser.downloadDir,
		downloadRootDir: params.browser.downloadRootDir,
		paths: requestedPaths,
	});
	const candidates = splitRefCandidates(params.ref);
	const attemptErrors: string[] = [];
	const visibleTargetNames = getSemanticRefTargets(params.browser)
		.map((target) => target.name ?? "")
		.join("\n")
		.toLowerCase();
	const baselineContainedAllNames = requestedFileNames.every((name) =>
		visibleTargetNames.includes(name.toLowerCase()),
	);

	for (const candidateRef of candidates) {
		try {
			const application = await uploadFilesToCandidate({
				browser: params.browser,
				ref: candidateRef,
				resolvedPaths,
			});
			return await observeUploadState({
				browser: params.browser,
				requestedPaths,
				method: application.method,
				baselineContainedAllNames,
			});
		} catch (error) {
			attemptErrors.push(`${candidateRef}: ${toErrorMessage(error)}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	throw new Error(`Failed to upload files to ref=${params.ref}: ${summary}`);
}
