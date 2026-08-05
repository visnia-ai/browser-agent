import * as fs from "fs";
import type { Browser } from "../types.js";
import { resolveLocalFile } from "../../file-workspace.js";
import {
	checkVisibility,
	isStaleNodeErrorMessage,
	resolveElement,
	sleep,
	splitRefCandidates,
	toErrorMessage,
} from "./utils.js";

function resolvePasteFilePath(params: {
	fileWorkspaceRoot: string;
	downloadDir?: string;
	downloadRootDir?: string;
	path: string;
}): string {
	try {
		return resolveLocalFile({
			requestedPath: params.path,
			roots: {
				fileWorkspaceRoot: params.fileWorkspaceRoot,
				downloadDir: params.downloadDir,
				downloadRootDir: params.downloadRootDir,
			},
		}).resolvedPath;
	} catch (error) {
		throw new Error(
			`paste_file ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function pasteTextIntoElement(params: {
	browser: Browser;
	objectId: string;
	text: string;
}): Promise<void> {
	await params.browser.Runtime.callFunctionOn({
		objectId: params.objectId,
		functionDeclaration: `function(text) {
			const element = this;
			const normalizedText = String(text).replace(/\\r\\n?/g, "\\n");
			if (typeof element.focus === "function") {
				try {
					element.focus({ preventScroll: true });
				} catch {
					element.focus();
				}
			}
			const setNativeValue = (target, value) => {
				const prototype = target instanceof HTMLTextAreaElement
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype;
				const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
				if (descriptor && typeof descriptor.set === "function") {
					descriptor.set.call(target, value);
				} else {
					target.value = value;
				}
			};
			if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
				setNativeValue(element, normalizedText);
			} else if (element.isContentEditable) {
				element.textContent = normalizedText;
			} else {
				throw new Error("target is not an input, textarea, or contenteditable element");
			}
			element.dispatchEvent(new InputEvent("input", {
				bubbles: true,
				cancelable: true,
				inputType: "insertFromPaste",
				data: normalizedText,
			}));
			element.dispatchEvent(new Event("change", { bubbles: true }));
		}`,
		arguments: [{ value: params.text }],
	});
}

export async function pasteFile(params: {
	browser: Browser;
	ref: string;
	path: string;
	fileWorkspaceRoot: string;
}): Promise<void> {
	const resolvedPath = resolvePasteFilePath({
		fileWorkspaceRoot: params.fileWorkspaceRoot,
		downloadDir: params.browser.downloadDir,
		downloadRootDir: params.browser.downloadRootDir,
		path: params.path,
	});
	const text = fs.readFileSync(resolvedPath, "utf-8");
	const candidates = splitRefCandidates(params.ref);
	const attemptErrors: string[] = [];

	for (const candidateRef of candidates) {
		const pasteIntoCandidate = async (): Promise<void> => {
			let nodeContext = await resolveElement(
				params.browser,
				candidateRef,
			);

			async function refreshNodeContext() {
				nodeContext = await resolveElement(
					params.browser,
					candidateRef,
				);
			}

			try {
				await checkVisibility(
					params.browser,
					candidateRef,
					nodeContext.objectId,
				);
				await params.browser.DOM.scrollIntoViewIfNeeded({
					nodeId: nodeContext.nodeId,
				});
			} catch (error) {
				if (isStaleNodeErrorMessage(toErrorMessage(error))) {
					await refreshNodeContext();
					await checkVisibility(
						params.browser,
						candidateRef,
						nodeContext.objectId,
					);
					await params.browser.DOM.scrollIntoViewIfNeeded({
						nodeId: nodeContext.nodeId,
					});
				} else {
					throw error;
				}
			}

			await pasteTextIntoElement({
				browser: params.browser,
				objectId: nodeContext.objectId,
				text,
			});
			await sleep(200);
		};

		try {
			await pasteIntoCandidate();
			return;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			attemptErrors.push(`${candidateRef}: ${message}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	console.log(`\t❌ Failed to paste file into ref=${params.ref}: ${summary}`);
	throw new Error(`Failed to paste file into ref=${params.ref}: ${summary}`);
}
