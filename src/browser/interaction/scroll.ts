import type { Browser } from "../types.js";
import {
	checkVisibility,
	resolveElement,
	sleep,
	splitRefCandidates,
} from "./utils.js";

type ScrollPreference = "target" | "container";

const scrollPreferenceByBrowser = new WeakMap<
	Browser,
	Map<string, ScrollPreference>
>();

function getScrollPreferenceMap(b: Browser): Map<string, ScrollPreference> {
	let map = scrollPreferenceByBrowser.get(b);
	if (!map) {
		map = new Map<string, ScrollPreference>();
		scrollPreferenceByBrowser.set(b, map);
	}
	return map;
}

async function getScrollSignature(
	b: Browser,
	objectId: string,
): Promise<string> {
	const { result } = await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function() {
      const pieces = [];
      let node = this;
      for (let i = 0; i < 10 && node; i += 1) {
        if (node instanceof Element) {
          pieces.push(node.scrollLeft + "," + node.scrollTop);
          node = node.parentElement;
          continue;
        }
        break;
      }
      const se = document.scrollingElement;
      pieces.push("w:" + window.scrollX + "," + window.scrollY);
      if (se) pieces.push("se:" + se.scrollLeft + "," + se.scrollTop);
      return pieces.join("|");
    }`,
		returnByValue: true,
	});
	return typeof result.value === "string" ? result.value : "";
}

async function tryCdpWheelAtElementCenter(
	b: Browser,
	nodeId: number,
	deltaX: number,
	deltaY: number,
): Promise<void> {
	const { model } = await b.DOM.getBoxModel({ nodeId });
	const x = (model.content[0] + model.content[4]) / 2;
	const y = (model.content[1] + model.content[5]) / 2;
	await b.Input.dispatchMouseEvent({
		type: "mouseMoved",
		x,
		y,
	});
	await b.Input.dispatchMouseEvent({
		type: "mouseWheel",
		x,
		y,
		deltaX,
		deltaY,
	});
}

async function runJsScrollAttempt(
	b: Browser,
	objectId: string,
	deltaX: number,
	deltaY: number,
	preferContainer: boolean,
): Promise<ScrollPreference | null> {
	const { result } = await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function(deltaX, deltaY, preferContainer) {
      const canScroll = (el) => {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        const allowsX = /(auto|scroll|overlay)/.test(style.overflowX);
        const allowsY = /(auto|scroll|overlay)/.test(style.overflowY);
        const overflowX = el.scrollWidth > el.clientWidth;
        const overflowY = el.scrollHeight > el.clientHeight;
        return (allowsX && overflowX) || (allowsY && overflowY);
      };

      const before = new Map();
      const mark = (el) => {
        if (!(el instanceof Element)) return;
        if (!before.has(el)) before.set(el, [el.scrollLeft, el.scrollTop]);
      };

      const self = this instanceof Element ? this : null;
      const se = document.scrollingElement instanceof Element ? document.scrollingElement : null;

      let cursor = self;
      for (let i = 0; i < 10 && cursor; i += 1) {
        mark(cursor);
        cursor = cursor.parentElement;
      }
      if (se) mark(se);
      if (document.documentElement instanceof Element) mark(document.documentElement);
      if (document.body instanceof Element) mark(document.body);
      const beforeWindowX = window.scrollX;
      const beforeWindowY = window.scrollY;

      const targets = [];
      const add = (el) => {
        if (!(el instanceof Element)) return;
        if (!targets.includes(el)) targets.push(el);
      };

      if (!preferContainer && self) add(self);
      let parent = self ? self.parentElement : null;
      while (parent) {
        if (canScroll(parent)) add(parent);
        parent = parent.parentElement;
      }
      if (se) add(se);
      if (document.documentElement instanceof Element) add(document.documentElement);
      if (document.body instanceof Element) add(document.body);
      if (preferContainer && self) add(self);

      const wheel = new WheelEvent("wheel", {
        deltaX,
        deltaY,
        bubbles: true,
        cancelable: true,
      });

      for (const target of targets) {
        target.dispatchEvent(wheel);
        const left = target.scrollLeft;
        const top = target.scrollTop;
        if (typeof target.scrollBy === "function") {
          target.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
        } else {
          target.scrollLeft = left + deltaX;
          target.scrollTop = top + deltaY;
        }

        for (const [el, [beforeLeft, beforeTop]] of before.entries()) {
          if (el.scrollLeft !== beforeLeft || el.scrollTop !== beforeTop) {
            return self && el === self ? "target" : "container";
          }
        }
        if (window.scrollX !== beforeWindowX || window.scrollY !== beforeWindowY) {
          return "container";
        }
      }

      if (targets.length === 0 || !targets.some((el) => canScroll(el))) {
        window.scrollBy(deltaX, deltaY);
      }

      for (const [el, [left, top]] of before.entries()) {
        if (el.scrollLeft !== left || el.scrollTop !== top) {
          return self && el === self ? "target" : "container";
        }
      }

      if (window.scrollX !== beforeWindowX || window.scrollY !== beforeWindowY) {
        return "container";
      }
      return null;
    }`,
		arguments: [
			{ value: deltaX },
			{ value: deltaY },
			{ value: preferContainer },
		],
		returnByValue: true,
	});

	if (result.value === "target" || result.value === "container") {
		return result.value;
	}
	if (result.value === true) {
		return preferContainer ? "container" : "target";
	}
	return null;
}

export async function scroll(
	b: Browser,
	ref: string,
	deltaX: number,
	deltaY: number,
): Promise<void> {
	const candidates = splitRefCandidates(ref);
	const attemptErrors: string[] = [];
	const scrollPreference = getScrollPreferenceMap(b);

	for (const candidateRef of candidates) {
		try {
			const { nodeId, objectId } = await resolveElement(b, candidateRef);
			await checkVisibility(b, candidateRef, objectId);
			const beforeSignature = await getScrollSignature(b, objectId);
			const preferContainer =
				scrollPreference.get(candidateRef) === "container";

			if (!preferContainer) {
				try {
					await tryCdpWheelAtElementCenter(b, nodeId, deltaX, deltaY);
					// CDP wheel scrolling is applied asynchronously on some pages.
					await sleep(50);
				} catch {
					// Fall through to JS fallback.
				}
			}

			const afterCdpSignature = await getScrollSignature(b, objectId);
			if (afterCdpSignature !== beforeSignature) {
				scrollPreference.set(candidateRef, "target");
				await sleep(120);
				return;
			}

			const jsChangedBy = await runJsScrollAttempt(
				b,
				objectId,
				deltaX,
				deltaY,
				preferContainer,
			);
			if (jsChangedBy) {
				scrollPreference.set(candidateRef, jsChangedBy);
				await sleep(120);
				return;
			}

			const afterJsSignature = await getScrollSignature(b, objectId);
			if (afterJsSignature !== beforeSignature) {
				scrollPreference.set(
					candidateRef,
					preferContainer ? "container" : "target",
				);
				await sleep(120);
				return;
			}

			// Last resort only: avoid repeated re-anchoring that can reset virtualized feeds.
			await b.DOM.scrollIntoViewIfNeeded({ nodeId });
			const beforeRetrySignature = await getScrollSignature(b, objectId);
			try {
				await tryCdpWheelAtElementCenter(b, nodeId, deltaX, deltaY);
			} catch {
				// Fall through to JS retry.
			}
			const afterRetryCdpSignature = await getScrollSignature(
				b,
				objectId,
			);
			if (afterRetryCdpSignature !== beforeRetrySignature) {
				scrollPreference.set(candidateRef, "target");
				await sleep(120);
				return;
			}

			const jsRetryChangedBy = await runJsScrollAttempt(
				b,
				objectId,
				deltaX,
				deltaY,
				true,
			);
			if (jsRetryChangedBy) {
				scrollPreference.set(candidateRef, jsRetryChangedBy);
				await sleep(120);
				return;
			}

			throw new Error(
				"scroll did not change target/ancestor/viewport state",
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			attemptErrors.push(`${candidateRef}: ${message}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	console.log(
		`    ❌ Failed to scroll ref=${ref} deltaX=${deltaX} deltaY=${deltaY}: ${summary}`,
	);
	throw new Error(
		`Failed to scroll ref=${ref} deltaX=${deltaX} deltaY=${deltaY}: ${summary}`,
	);
}
