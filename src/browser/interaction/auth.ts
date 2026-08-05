import type { Browser } from "../types.js";
import {
	checkVisibility,
	resolveElement,
	splitRefCandidates,
	toErrorMessage,
} from "./utils.js";

export async function assertPasswordInputRef(
	b: Browser,
	ref: string,
): Promise<void> {
	const candidates = splitRefCandidates(ref);
	const attemptErrors: string[] = [];

	for (const candidateRef of candidates) {
		try {
			const { objectId } = await resolveElement(b, candidateRef);
			await checkVisibility(b, candidateRef, objectId);
			const { result } = await b.Runtime.callFunctionOn({
				objectId,
				functionDeclaration: `function() {
					if (!(this instanceof HTMLInputElement)) {
						return "element is not an HTMLInputElement";
					}
					const inputType = (this.type || "").toLowerCase();
					if (inputType !== "password") {
						return inputType
							? 'input type is "' + inputType + '"'
							: "input type is empty";
					}
					return "";
				}`,
				returnByValue: true,
			});
			if (typeof result.value === "string" && result.value) {
				throw new Error(result.value);
			}
			return;
		} catch (error) {
			attemptErrors.push(`${candidateRef}: ${toErrorMessage(error)}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	throw new Error(
		`Failed password input verification for ref=${ref}: ${summary}`,
	);
}

export async function ensureCheckboxChecked(
	b: Browser,
	ref: string,
): Promise<void> {
	const candidates = splitRefCandidates(ref);
	const attemptErrors: string[] = [];

	for (const candidateRef of candidates) {
		try {
			const { objectId } = await resolveElement(b, candidateRef);
			await checkVisibility(b, candidateRef, objectId);
			const { result } = await b.Runtime.callFunctionOn({
				objectId,
				functionDeclaration: `function() {
					const resolveCheckbox = (target) => {
						if (
							target instanceof HTMLInputElement &&
							target.type.toLowerCase() === "checkbox"
						) {
							return target;
						}
						if (target instanceof HTMLLabelElement) {
							if (
								target.control instanceof HTMLInputElement &&
								target.control.type.toLowerCase() === "checkbox"
							) {
								return target.control;
							}
							const nested = target.querySelector(
								'input[type="checkbox"]',
							);
							if (nested instanceof HTMLInputElement) {
								return nested;
							}
						}
						return null;
					};

					const checkbox = resolveCheckbox(this);
					if (!checkbox) {
						return "element is not a checkbox or associated label";
					}
					if (checkbox.disabled) {
						return "checkbox is disabled";
					}
					if (checkbox.checked) {
						return "";
					}
					checkbox.click();
					return checkbox.checked
						? ""
						: "checkbox did not become checked after click";
				}`,
				returnByValue: true,
			});
			if (typeof result.value === "string" && result.value) {
				throw new Error(result.value);
			}
			return;
		} catch (error) {
			attemptErrors.push(`${candidateRef}: ${toErrorMessage(error)}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	throw new Error(`Failed checkbox verification for ref=${ref}: ${summary}`);
}

export async function readIdentifierInputByRef(
	b: Browser,
	ref: string,
): Promise<{ value: string; editable: boolean }> {
	const candidates = splitRefCandidates(ref);
	const attemptErrors: string[] = [];

	for (const candidateRef of candidates) {
		try {
			const { objectId } = await resolveElement(b, candidateRef);
			await checkVisibility(b, candidateRef, objectId);
			const { result } = await b.Runtime.callFunctionOn({
				objectId,
				functionDeclaration: `function() {
					const target = this;
					if (
						!(
							target instanceof HTMLInputElement ||
							target instanceof HTMLTextAreaElement
						)
					) {
						return {
							error: "element is not an input or textarea",
						};
					}
					const inputType =
						target instanceof HTMLInputElement
							? (target.type || "").toLowerCase()
							: "textarea";
					if (inputType === "password") {
						return { error: "element is a password input" };
					}
					return {
						value: target.value || "",
						editable: !target.disabled && !target.readOnly,
					};
				}`,
				returnByValue: true,
			});
			const payload = result.value as
				| { value?: unknown; editable?: unknown; error?: unknown }
				| undefined;
			if (payload?.error) {
				throw new Error(String(payload.error));
			}
			return {
				value: typeof payload?.value === "string" ? payload.value : "",
				editable: payload?.editable === true,
			};
		} catch (error) {
			attemptErrors.push(`${candidateRef}: ${toErrorMessage(error)}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	throw new Error(`Failed identifier read for ref=${ref}: ${summary}`);
}
