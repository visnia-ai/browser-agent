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

async function installClickProbe(
	b: Browser,
	objectId: string,
): Promise<string> {
	const token = `ba-click-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function(token) {
      const w = window;
      const storeKey = "__baClickProbeStore";
      if (!w[storeKey]) w[storeKey] = Object.create(null);
      const listener = (event) => {
        const path =
          typeof event.composedPath === "function"
            ? event.composedPath()
            : [];
        if (Array.isArray(path) && path.includes(this)) {
          w[storeKey][token].hit = true;
          return;
        }
        const target = event.target;
        if (!target) return;
        if (target === this || (target instanceof Node && this.contains(target))) {
          w[storeKey][token].hit = true;
        }
      };
      w[storeKey][token] = { hit: false, listener };
      document.addEventListener("click", listener, true);
    }`,
		arguments: [{ value: token }],
	});
	return token;
}

async function wasClickProbeHit(
	b: Browser,
	objectId: string,
	token: string,
): Promise<boolean> {
	const { result } = await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function(token) {
      const w = window;
      const storeKey = "__baClickProbeStore";
      const entry = w[storeKey] && w[storeKey][token];
      if (!entry) return false;
      if (entry.listener) {
        document.removeEventListener("click", entry.listener, true);
      }
      const hit = !!entry.hit;
      delete w[storeKey][token];
      return hit;
    }`,
		arguments: [{ value: token }],
		returnByValue: true,
	});
	return Boolean(result.value);
}

async function runProbedClickAttempt(
	b: Browser,
	objectId: string,
	clickAction: () => Promise<void>,
	treatActionNavigationAsSuccess = false,
): Promise<boolean> {
	const probeToken = await installClickProbe(b, objectId);

	try {
		await clickAction();
	} catch (error) {
		if (
			treatActionNavigationAsSuccess &&
			isLikelyNavigationAfterClickError(toErrorMessage(error))
		) {
			return true;
		}
		throw error;
	}

	try {
		return await wasClickProbeHit(b, objectId, probeToken);
	} catch (error) {
		if (isLikelyNavigationAfterClickError(toErrorMessage(error))) {
			return true;
		}
		throw error;
	}
}

async function clickElementUsingJavaScript(
	b: Browser,
	objectId: string,
): Promise<void> {
	await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function() {
      if (typeof this.click === "function") {
        this.click();
        return;
      }
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      });
      this.dispatchEvent(event);
    }`,
	});
}

async function showClickIndicator(b: Browser, x: number, y: number) {
	await b.Runtime.evaluate({
		expression: `(() => {
      // Create or get existing cursor element
      let el = document.getElementById('__ba_cursor');
      let style = document.getElementById('__ba_cursor_style');

      if (!style) {
        style = document.createElement('style');
        style.id = '__ba_cursor_style';
        style.textContent = \`
          @keyframes __ba_pulse {
            0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.9; }
            50% { transform: translate(-50%, -50%) scale(1.3); opacity: 0.6; }
          }
          @keyframes __ba_move {
            0% { transform: translate(-50%, -50%) scale(1.2); }
            100% { transform: translate(-50%, -50%) scale(1); }
          }
          #__ba_cursor {
            position: fixed;
            z-index: 2147483647;
            pointer-events: none;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(255,80,80,0.8) 0%, rgba(255,50,50,0.4) 70%, transparent 100%);
            border: 2px solid rgba(255,50,50,0.9);
            box-shadow: 0 0 10px rgba(255,50,50,0.5), 0 0 20px rgba(255,50,50,0.3);
            transform: translate(-50%, -50%);
            transition: left 0.15s ease-out, top 0.15s ease-out;
            animation: __ba_pulse 1.5s ease-in-out infinite;
          }
          #__ba_cursor.moving {
            animation: __ba_move 0.15s ease-out;
          }
        \`;
        document.head.appendChild(style);
      }

      if (!el) {
        el = document.createElement('div');
        el.id = '__ba_cursor';
        el.setAttribute('data-ba-ignore', 'true');
        document.body.appendChild(el);
      }

      // Trigger move animation
      el.classList.add('moving');
      el.style.left = '${x}px';
      el.style.top = '${y}px';

      // Remove move class after animation
      setTimeout(() => el.classList.remove('moving'), 150);
    })()`,
	});
}

export async function click(b: Browser, ref: string): Promise<void> {
	const candidates = splitRefCandidates(ref);
	const attemptErrors: string[] = [];

	for (const candidateRef of candidates) {
		const clickCandidate = async (): Promise<void> => {
			let nodeContext = await resolveElement(b, candidateRef);

			async function refreshNodeContext() {
				nodeContext = await resolveElement(b, candidateRef);
			}

			async function ensureVisible() {
				try {
					await checkVisibility(
						b,
						candidateRef,
						nodeContext.objectId,
					);
				} catch (error) {
					if (isStaleNodeErrorMessage(toErrorMessage(error))) {
						await refreshNodeContext();
						await checkVisibility(
							b,
							candidateRef,
							nodeContext.objectId,
						);
						return;
					}
					throw error;
				}
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

			async function fetchBoxModel(): Promise<{
				model: { content: number[] };
			}> {
				try {
					return await b.DOM.getBoxModel({
						nodeId: nodeContext.nodeId,
					});
				} catch (error) {
					if (isStaleNodeErrorMessage(toErrorMessage(error))) {
						await refreshNodeContext();
						return await b.DOM.getBoxModel({
							nodeId: nodeContext.nodeId,
						});
					}
					throw error;
				}
			}

			await ensureVisible();
			await ensureScroll();
			const { model } = await fetchBoxModel();
			const cx = (model.content[0] + model.content[4]) / 2;
			const cy = (model.content[1] + model.content[5]) / 2;
			let clickRegistered = false;
			clickRegistered = await runProbedClickAttempt(
				b,
				nodeContext.objectId,
				async () => {
					await b.Input.dispatchMouseEvent({
						type: "mousePressed",
						x: cx,
						y: cy,
						button: "left",
						clickCount: 1,
					});
					await b.Input.dispatchMouseEvent({
						type: "mouseReleased",
						x: cx,
						y: cy,
						button: "left",
						clickCount: 1,
					});
					await showClickIndicator(b, cx, cy);
				},
			);

			if (!clickRegistered) {
				clickRegistered = await runProbedClickAttempt(
					b,
					nodeContext.objectId,
					async () =>
						clickElementUsingJavaScript(b, nodeContext.objectId),
					true,
				);
			}

			if (!clickRegistered) {
				throw new Error("click was not registered on target element");
			}

			await sleep(200);
		};

		try {
			await clickCandidate();
			return;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			attemptErrors.push(`${candidateRef}: ${message}`);
		}
	}

	const summary = attemptErrors.length
		? attemptErrors.join(" | ")
		: "no candidate refs provided";
	console.log(`    ❌ Failed to click ref=${ref}: ${summary}`);
	throw new Error(`Failed to click ref=${ref}: ${summary}`);
}
