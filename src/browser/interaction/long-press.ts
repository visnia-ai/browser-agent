import type { Browser } from "../types.js";
import {
	checkVisibility,
	isLikelyNavigationAfterClickError,
	isStaleNodeErrorMessage,
	resolveElement,
	sleep,
	splitRefCandidates,
	toErrorMessage,
} from "./utils.js";

export const DEFAULT_LONG_PRESS_DURATION_MS = 3_000;
export const MIN_LONG_PRESS_DURATION_MS = 100;
export const MAX_LONG_PRESS_DURATION_MS = 15_000;

function validateDuration(durationMs: number): void {
	if (
		!Number.isInteger(durationMs) ||
		durationMs < MIN_LONG_PRESS_DURATION_MS ||
		durationMs > MAX_LONG_PRESS_DURATION_MS
	) {
		throw new Error(
			`long press duration must be an integer between ${MIN_LONG_PRESS_DURATION_MS} and ${MAX_LONG_PRESS_DURATION_MS} ms`,
		);
	}
}

async function resolvePressPoint(
	b: Browser,
	ref: string,
): Promise<{ x: number; y: number }> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const { nodeId, objectId } = await resolveElement(b, ref);
			await checkVisibility(b, ref, objectId);
			await b.DOM.scrollIntoViewIfNeeded({ nodeId });
			const { model } = await b.DOM.getBoxModel({ nodeId });
			const content = model.content;
			if (!content || content.length < 8) {
				throw new Error("target element has no usable content box");
			}
			return {
				x: (content[0] + content[2] + content[4] + content[6]) / 4,
				y: (content[1] + content[3] + content[5] + content[7]) / 4,
			};
		} catch (error) {
			if (
				attempt === 0 &&
				isStaleNodeErrorMessage(toErrorMessage(error))
			) {
				continue;
			}
			throw error;
		}
	}
	throw new Error(`Unable to resolve long press target: ref=${ref}`);
}

async function dispatchLongPress(
	b: Browser,
	x: number,
	y: number,
	durationMs: number,
): Promise<void> {
	await b.Input.dispatchMouseEvent({
		type: "mouseMoved",
		x,
		y,
		button: "none",
		buttons: 0,
		pointerType: "mouse",
	});
	await sleep(50);

	let pressed = false;
	let pressError: unknown;
	try {
		pressed = true;
		await b.Input.dispatchMouseEvent({
			type: "mousePressed",
			x,
			y,
			button: "left",
			buttons: 1,
			clickCount: 1,
			pointerType: "mouse",
		});
		await sleep(durationMs);
	} catch (error) {
		pressError = error;
	} finally {
		if (pressed) {
			try {
				await b.Input.dispatchMouseEvent({
					type: "mouseReleased",
					x,
					y,
					button: "left",
					buttons: 0,
					clickCount: 1,
					pointerType: "mouse",
				});
			} catch (releaseError) {
				if (
					!isLikelyNavigationAfterClickError(
						toErrorMessage(releaseError),
					) &&
					pressError === undefined
				) {
					throw releaseError;
				}
			}
		}
	}

	if (
		pressError !== undefined &&
		!isLikelyNavigationAfterClickError(toErrorMessage(pressError))
	) {
		throw pressError;
	}
	await sleep(200);
}

export async function longPress(
	b: Browser,
	ref: string,
	durationMs = DEFAULT_LONG_PRESS_DURATION_MS,
): Promise<void> {
	validateDuration(durationMs);
	const candidates = splitRefCandidates(ref);
	const attemptErrors: string[] = [];

	for (const candidateRef of candidates) {
		try {
			const { x, y } = await resolvePressPoint(b, candidateRef);
			await dispatchLongPress(b, x, y, durationMs);
			return;
		} catch (error) {
			attemptErrors.push(`${candidateRef}: ${toErrorMessage(error)}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	throw new Error(`Failed to long press ref=${ref}: ${summary}`);
}
