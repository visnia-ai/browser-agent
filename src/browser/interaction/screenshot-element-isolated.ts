import CDP from "chrome-remote-interface";
import { withLocalCdpHost } from "../local-cdp.js";
import type { Browser } from "../types.js";
import { getLiveInputValuesByBackendNodeId } from "../simplify-dom-utils/dom-snapshot-helpers.js";
import { captureScreenshotWithBidBorders } from "./capture-screenshot-with-bid-borders.js";
import {
	checkVisibility,
	resolveElement,
	splitRefCandidates,
	toErrorMessage,
} from "./utils.js";

interface IsolatedRenderPayload {
	rootHtml: string;
	cssText: string;
	baseURI: string;
	rootBoxModel: Record<string, string>;
}

const FORM_CONTROL_SELECTOR = "input,textarea,select";
const FORM_CONTROL_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

async function getFormControlBackendNodeIdsInSubtree(
	b: Browser,
	rootNodeId: number,
): Promise<number[]> {
	const backendIds: number[] = [];
	const seen = new Set<number>();

	const appendIfFormControl = async (nodeId: number): Promise<void> => {
		const { node } = await b.DOM.describeNode({ nodeId });
		const nodeName =
			typeof node.nodeName === "string"
				? node.nodeName.toUpperCase()
				: "";
		if (!FORM_CONTROL_TAGS.has(nodeName)) return;
		const backendId = node.backendNodeId;
		if (!backendId || seen.has(backendId)) return;
		seen.add(backendId);
		backendIds.push(backendId);
	};

	try {
		await appendIfFormControl(rootNodeId);
	} catch {
		// Best effort: continue with descendants.
	}

	try {
		const { nodeIds } = await b.DOM.querySelectorAll({
			nodeId: rootNodeId,
			selector: FORM_CONTROL_SELECTOR,
		});
		for (const nodeId of nodeIds) {
			try {
				await appendIfFormControl(nodeId);
			} catch {
				// Best effort: ignore nodes that fail to resolve.
			}
		}
	} catch {
		// Best effort: subtree might be detached.
	}

	return backendIds;
}

async function getLiveFormControlValuesInSubtree(
	b: Browser,
	rootNodeId: number,
): Promise<string[]> {
	const backendIds = await getFormControlBackendNodeIdsInSubtree(
		b,
		rootNodeId,
	);
	if (backendIds.length === 0) return [];

	const liveByBackend = await getLiveInputValuesByBackendNodeId({
		b,
		backendNodeIds: backendIds,
	});

	return backendIds.map((backendId) => liveByBackend.get(backendId) ?? "");
}

async function extractIsolatedRenderPayload(
	b: Browser,
	objectId: string,
	liveFormControlValues: string[],
): Promise<IsolatedRenderPayload> {
	const { result } = await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function(liveFormControlValues) {
      const source = this;
      const clone = source.cloneNode(true);
      if (clone && clone.setAttribute) {
        clone.setAttribute("data-ba-isolated-root", "1");
      }
      const collectFormControls = (root) => {
        const controls = [];
        if (
          root instanceof HTMLInputElement ||
          root instanceof HTMLTextAreaElement ||
          root instanceof HTMLSelectElement
        ) {
          controls.push(root);
        }
        for (const el of Array.from(root.querySelectorAll("${FORM_CONTROL_SELECTOR}"))) {
          controls.push(el);
        }
        return controls;
      };
      const cloneControls = collectFormControls(clone);
      const values = Array.isArray(liveFormControlValues)
        ? liveFormControlValues
        : [];
      for (let i = 0; i < cloneControls.length; i++) {
        const control = cloneControls[i];
        const liveValue = typeof values[i] === "string" ? values[i] : "";
        if (
          control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement
        ) {
          control.value = liveValue;
          control.setAttribute("value", liveValue);
          continue;
        }
        if (control instanceof HTMLSelectElement) {
          control.value = liveValue;
          for (const option of Array.from(control.options)) {
            if (option.value === liveValue) {
              option.selected = true;
              option.setAttribute("selected", "selected");
            } else {
              option.selected = false;
              option.removeAttribute("selected");
            }
          }
        }
      }
      const sourceComputed = window.getComputedStyle(source);
      const sourceRect = source.getBoundingClientRect();
      const rootBoxModel = {
        "box-sizing": "border-box",
        "display": sourceComputed.display,
        "width": Math.max(1, Math.ceil(sourceRect.width)) + "px",
        "height": Math.max(1, Math.ceil(sourceRect.height)) + "px",
        "margin-top": sourceComputed.marginTop,
        "margin-right": sourceComputed.marginRight,
        "margin-bottom": sourceComputed.marginBottom,
        "margin-left": sourceComputed.marginLeft,
        "padding-top": sourceComputed.paddingTop,
        "padding-right": sourceComputed.paddingRight,
        "padding-bottom": sourceComputed.paddingBottom,
        "padding-left": sourceComputed.paddingLeft,
        "border-top-width": sourceComputed.borderTopWidth,
        "border-top-style": sourceComputed.borderTopStyle,
        "border-top-color": sourceComputed.borderTopColor,
        "border-right-width": sourceComputed.borderRightWidth,
        "border-right-style": sourceComputed.borderRightStyle,
        "border-right-color": sourceComputed.borderRightColor,
        "border-bottom-width": sourceComputed.borderBottomWidth,
        "border-bottom-style": sourceComputed.borderBottomStyle,
        "border-bottom-color": sourceComputed.borderBottomColor,
        "border-left-width": sourceComputed.borderLeftWidth,
        "border-left-style": sourceComputed.borderLeftStyle,
        "border-left-color": sourceComputed.borderLeftColor
      };

      const cssChunks = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          if (!sheet.cssRules) continue;
          let cssText = "";
          for (const rule of Array.from(sheet.cssRules)) {
            cssText += rule.cssText + "\\n";
          }
          if (cssText) cssChunks.push(cssText);
        } catch {
          // Ignore cross-origin/inaccessible stylesheets.
        }
      }

      return {
        rootHtml: clone && clone.outerHTML ? clone.outerHTML : "",
        cssText: cssChunks.join("\\n"),
        baseURI: document.baseURI || location.href || "about:blank",
        rootBoxModel,
      };
    }`,
		arguments: [{ value: liveFormControlValues }],
		returnByValue: true,
	});

	const payload = result.value as IsolatedRenderPayload | undefined;
	if (
		!payload ||
		typeof payload.rootHtml !== "string" ||
		typeof payload.cssText !== "string" ||
		typeof payload.baseURI !== "string" ||
		!payload.rootBoxModel ||
		typeof payload.rootBoxModel !== "object" ||
		!payload.rootHtml
	) {
		throw new Error(
			"Failed to extract element HTML/CSS for isolated render",
		);
	}
	return payload;
}

async function renderInIsolatedPageAndScreenshot(
	b: Browser,
	payload: IsolatedRenderPayload,
	highlightBids: string[],
): Promise<string> {
	const { targetId } = await b.Target.createTarget({ url: "about:blank" });
	const isolatedClient = await CDP(
		withLocalCdpHost({ port: b.port, target: targetId }),
	);
	const { Page, Runtime } = isolatedClient;

	try {
		await Promise.all([Page.enable(), Runtime.enable()]);

		const isolatedHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <base href="${payload.baseURI}" />
    <style>${payload.cssText}</style>
    <style>
      html, body { margin: 0; padding: 0; }
      body { background: transparent; }
      [data-ba-isolated-root="1"] { display: block; }
    </style>
  </head>
  <body>${payload.rootHtml}</body>
</html>`;

		await Runtime.evaluate({
			expression: `(() => {
        document.open();
        document.write(${JSON.stringify(isolatedHtml)});
        document.close();
      })()`,
			awaitPromise: true,
		});

		const { result: applyBoxResult } = await Runtime.evaluate({
			expression: `(() => {
        const el = document.querySelector('[data-ba-isolated-root="1"]');
        if (!el) return false;
        const model = ${JSON.stringify(payload.rootBoxModel)};
        for (const [prop, value] of Object.entries(model)) {
          if (typeof value !== "string" || !value) continue;
          el.style.setProperty(prop, value);
        }
        return true;
      })()`,
			returnByValue: true,
		});
		if (!applyBoxResult.value) {
			throw new Error("Failed to apply box model to isolated element");
		}

		await Runtime.evaluate({
			expression: `new Promise((resolve) => {
        const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (document.readyState === "complete") {
          done();
          return;
        }
        window.addEventListener("load", done, { once: true });
        setTimeout(done, 1500);
      })`,
			awaitPromise: true,
		});

		const { result: clipResult } = await Runtime.evaluate({
			expression: `(() => {
        const el = document.querySelector('[data-ba-isolated-root="1"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: Math.max(1, Math.ceil(rect.width)),
          height: Math.max(1, Math.ceil(rect.height))
        };
      })()`,
			returnByValue: true,
		});

		const clip = clipResult.value as {
			x: number;
			y: number;
			width: number;
			height: number;
		} | null;
		if (
			!clip ||
			typeof clip.x !== "number" ||
			typeof clip.y !== "number" ||
			typeof clip.width !== "number" ||
			typeof clip.height !== "number"
		) {
			throw new Error("Failed to compute isolated render clip");
		}

		return await captureScreenshotWithBidBorders({
			page: Page,
			runtime: Runtime,
			dom: isolatedClient.DOM,
			bids: highlightBids,
			captureScreenshotParams: {
				format: "png",
				clip: {
					x: clip.x,
					y: clip.y,
					width: clip.width,
					height: clip.height,
					scale: 1,
				},
				captureBeyondViewport: false,
			},
		});
	} finally {
		try {
			await isolatedClient.close();
		} catch {
			// Best-effort client cleanup.
		}
		try {
			await b.Target.closeTarget({ targetId });
		} catch {
			// Best-effort target cleanup.
		}
	}
}

export async function screenshotElementInIsolatedPage(
	b: Browser,
	bid: string,
): Promise<string> {
	const candidates = splitRefCandidates(bid);
	const attemptErrors: string[] = [];

	for (const candidateBid of candidates) {
		try {
			const { nodeId, objectId } = await resolveElement(b, candidateBid);
			await checkVisibility(b, candidateBid, objectId);
			const liveFormControlValues =
				await getLiveFormControlValuesInSubtree(b, nodeId);
			const payload = await extractIsolatedRenderPayload(
				b,
				objectId,
				liveFormControlValues,
			);
			return await renderInIsolatedPageAndScreenshot(b, payload, [
				candidateBid,
			]);
		} catch (err) {
			const message = toErrorMessage(err);
			attemptErrors.push(`${candidateBid}: ${message}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate bids provided";
	throw new Error(
		`Failed to screenshot isolated element for bid=${bid}: ${summary}`,
	);
}
