import type { Browser } from "../types.js";
import { configFeatureFlags } from "../../config-feature-flags.js";
import {
	checkVisibility,
	isStaleNodeErrorMessage,
	resolveElement,
	sleep,
	splitRefCandidates,
	toErrorMessage,
} from "./utils.js";

function getNodeAttributeMap(attributes?: string[]): Map<string, string> {
	const attributeMap = new Map<string, string>();
	if (!Array.isArray(attributes)) {
		return attributeMap;
	}
	for (let index = 0; index < attributes.length; index += 2) {
		const name = attributes[index];
		const value = attributes[index + 1];
		if (typeof name !== "string") {
			continue;
		}
		attributeMap.set(
			name.toLowerCase(),
			typeof value === "string" ? value : "",
		);
	}
	return attributeMap;
}

type EditableTargetKind = "single-line" | "textarea" | "contenteditable";

function getEditableTargetKind(node: {
	nodeName?: string;
	attributes?: string[];
}): EditableTargetKind {
	const tagName =
		typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "";
	if (tagName === "textarea") {
		return "textarea";
	}
	const attributeMap = getNodeAttributeMap(node.attributes);
	if (attributeMap.get("contenteditable") === "true") {
		return "contenteditable";
	}
	return "single-line";
}

function isSafeBulkTextTarget(node: {
	nodeName?: string;
	attributes?: string[];
}): boolean {
	if (!configFeatureFlags.optimizeTextInput) return false;

	const attributes = getNodeAttributeMap(node.attributes);
	const role = attributes.get("role")?.toLowerCase();
	const ariaAutocomplete = attributes.get("aria-autocomplete")?.toLowerCase();
	if (
		role === "combobox" ||
		role === "searchbox" ||
		(ariaAutocomplete !== undefined && ariaAutocomplete !== "none") ||
		attributes.has("list")
	) {
		return false;
	}

	const tagName = node.nodeName?.toLowerCase() ?? "";
	if (
		tagName === "textarea" ||
		attributes.get("contenteditable") === "true"
	) {
		return true;
	}
	if (tagName !== "input") return false;

	const inputType = (attributes.get("type") ?? "text").toLowerCase();
	return ["email", "password", "tel", "text", "url"].includes(inputType);
}

function isDateInput(node: {
	nodeName?: string;
	attributes?: string[];
}): boolean {
	return (
		node.nodeName?.toLowerCase() === "input" &&
		getNodeAttributeMap(node.attributes).get("type")?.toLowerCase() ===
			"date"
	);
}

function isValidIsoDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (year < 1 || month < 1 || month > 12 || day < 1) return false;
	const daysInMonth = [
		31,
		year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return day <= daysInMonth[month - 1];
}

async function setIsoDateAndVerify(
	b: Browser,
	objectId: string,
	value: string,
): Promise<void> {
	if (!isValidIsoDate(value)) {
		throw new Error(
			`input[type=date] requires a valid ISO date in YYYY-MM-DD format; received ${JSON.stringify(value)}`,
		);
	}
	await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function(expected) {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value"
			)?.set;
			if (setter) setter.call(this, expected);
			else this.value = expected;
			this.dispatchEvent(new Event("input", {
				bubbles: true,
				composed: true,
			}));
			this.dispatchEvent(new Event("change", {
				bubbles: true,
				composed: true,
			}));
		}`,
		arguments: [{ value }],
	});
	await sleep(50);
	const { result } = await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function() {
			return typeof this.value === "string" ? this.value : "";
		}`,
		returnByValue: true,
	});
	const observed = typeof result.value === "string" ? result.value : "";
	if (observed !== value) {
		throw new Error(
			`input[type=date] rejected ISO date ${JSON.stringify(value)}; observed ${JSON.stringify(observed)}`,
		);
	}
}

async function dispatchCharacterInput(b: Browser, ch: string): Promise<void> {
	await b.Input.dispatchKeyEvent({ type: "keyDown", key: ch });
	await b.Input.dispatchKeyEvent({ type: "char", text: ch });
	await b.Input.dispatchKeyEvent({ type: "keyUp", key: ch });
}

async function insertTextAndVerify(
	b: Browser,
	objectId: string,
	text: string,
): Promise<boolean> {
	try {
		await b.Input.insertText({ text });
		const { result } = await b.Runtime.callFunctionOn({
			objectId,
			functionDeclaration: `function(expected) {
				const value = typeof this.value === "string" ? this.value : this.textContent;
				return value === expected;
			}`,
			arguments: [{ value: text }],
			returnByValue: true,
		});
		return result.value === true;
	} catch {
		return false;
	}
}

async function dispatchTextWithKeyEvents(
	b: Browser,
	text: string,
	allowsMultiline: boolean,
	objectId: string,
): Promise<void> {
	for (const ch of text) {
		if (allowsMultiline && ch === "\n") {
			await dispatchEnterKey(b, objectId, false);
			continue;
		}
		await dispatchCharacterInput(b, ch);
	}
}

async function dispatchEnterKey(
	b: Browser,
	objectId: string,
	submitForm: boolean,
): Promise<void> {
	try {
		await b.Input.dispatchKeyEvent({
			type: "keyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			nativeVirtualKeyCode: 13,
			unmodifiedText: "\r",
			text: "\r",
		});
		await b.Input.dispatchKeyEvent({
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			nativeVirtualKeyCode: 13,
		});
	} catch {
		await b.Runtime.callFunctionOn({
			objectId,
			functionDeclaration: `function() {
				this.focus();
				const eventInit = {
					key: "Enter",
					code: "Enter",
					keyCode: 13,
					which: 13,
					bubbles: true,
					cancelable: true,
				};
				const keyDownEvent = new KeyboardEvent("keydown", eventInit);
				const keyPressEvent = new KeyboardEvent("keypress", eventInit);
				const keyUpEvent = new KeyboardEvent("keyup", eventInit);
				const shouldContinue = this.dispatchEvent(keyDownEvent);
				this.dispatchEvent(keyPressEvent);
				this.dispatchEvent(keyUpEvent);
				if (${submitForm} && shouldContinue && this.form && typeof this.form.requestSubmit === "function") {
					this.form.requestSubmit();
				}
			}`,
		});
	}
}

export async function clearInputField(
	b: Browser,
	nodeId: number,
	objectId: string,
): Promise<void> {
	const { node } = await b.DOM.describeNode({ nodeId });
	const tagName =
		typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "";

	if (tagName === "input") {
		await b.Runtime.callFunctionOn({
			objectId,
			functionDeclaration: "function() { this.value = ''; }",
		});
	} else {
		await b.Input.dispatchKeyEvent({
			type: "keyDown",
			commands: ["selectAll"],
		});
		await b.Input.dispatchKeyEvent({
			type: "keyUp",
		});
		await b.Input.dispatchKeyEvent({
			type: "keyDown",
			commands: ["deleteBackward"],
		});
		await b.Input.dispatchKeyEvent({
			type: "keyUp",
		});
	}
}

export async function type(
	b: Browser,
	ref: string,
	text: string,
	enter = false,
): Promise<void> {
	const candidates = splitRefCandidates(ref);
	const attemptErrors: string[] = [];

	for (const candidateRef of candidates) {
		const typeIntoCandidate = async (): Promise<void> => {
			let nodeContext = await resolveElement(b, candidateRef);

			async function refreshNodeContext() {
				nodeContext = await resolveElement(b, candidateRef);
			}

			async function ensureScroll() {
				try {
					await b.DOM.scrollIntoViewIfNeeded({
						nodeId: nodeContext.nodeId,
					});
				} catch (error) {
					if (isStaleNodeErrorMessage(toErrorMessage(error))) {
						await refreshNodeContext();
						await b.DOM.scrollIntoViewIfNeeded({
							nodeId: nodeContext.nodeId,
						});
						return;
					}
					throw error;
				}
			}

			async function focusWithRetry() {
				try {
					await b.DOM.focus({ nodeId: nodeContext.nodeId });
				} catch (error) {
					if (isStaleNodeErrorMessage(toErrorMessage(error))) {
						await refreshNodeContext();
						await b.DOM.focus({ nodeId: nodeContext.nodeId });
						return;
					}
					throw error;
				}
			}

			await checkVisibility(b, candidateRef, nodeContext.objectId);
			await ensureScroll();
			await focusWithRetry();

			const { node } = await b.DOM.describeNode({
				nodeId: nodeContext.nodeId,
			});
			const targetKind = getEditableTargetKind(node);
			const allowsMultiline = targetKind !== "single-line";
			const normalizedText = allowsMultiline
				? text.replace(/\r\n?/g, "\n")
				: text;
			let verifiedBulkInsertion = false;
			const dateInput = isDateInput(node);

			if (dateInput) {
				await setIsoDateAndVerify(
					b,
					nodeContext.objectId,
					normalizedText,
				);
				verifiedBulkInsertion = true;
			} else {
				await clearInputField(
					b,
					nodeContext.nodeId,
					nodeContext.objectId,
				);
			}

			if (
				!dateInput &&
				targetKind === "contenteditable" &&
				normalizedText.includes("\n")
			) {
				await b.Input.insertText({ text: normalizedText });
			} else if (!dateInput && isSafeBulkTextTarget(node)) {
				const inserted = await insertTextAndVerify(
					b,
					nodeContext.objectId,
					normalizedText,
				);
				verifiedBulkInsertion = inserted;
				if (!inserted) {
					await clearInputField(
						b,
						nodeContext.nodeId,
						nodeContext.objectId,
					);
					await dispatchTextWithKeyEvents(
						b,
						normalizedText,
						allowsMultiline,
						nodeContext.objectId,
					);
				}
			} else if (!dateInput) {
				await dispatchTextWithKeyEvents(
					b,
					normalizedText,
					allowsMultiline,
					nodeContext.objectId,
				);
			}

			if (enter) {
				await dispatchEnterKey(b, nodeContext.objectId, true);
			}
			if (!verifiedBulkInsertion || enter) await sleep(200);
		};

		try {
			await typeIntoCandidate();
			return;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			attemptErrors.push(`${candidateRef}: ${message}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	console.log(`	❌ Failed to type into ref=${ref}: ${summary}`);
	throw new Error(`Failed to type into ref=${ref}: ${summary}`);
}
