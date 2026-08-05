import * as readline from "readline";
import type { Browser } from "../../browser/types.js";

const DEFAULT_SIGNAL = "resume";
const RESUME_FLAG_KEY = "__browserAgentResumeRequested";
const OVERLAY_ID = "__browserAgentUserTakeoverOverlay";
const OVERLAY_POLL_MS = 250;
const PRUNED_ATTRIBUTE_NAME = "data-ba-irrelevant-pruned";
const TAKEOVER_STYLE_CACHE_ATTRIBUTE_NAME =
	"data-ba-user-takeover-pruned-style";
const TAKEOVER_STYLE_PRESENT_ATTRIBUTE_NAME =
	"data-ba-user-takeover-pruned-style-present";

export interface WaitForUserTakeoverSignalOptions {
	reason: string;
	resumeSignal?: string;
	readSignal?: (question: string) => Promise<string>;
	log?: (line: string) => void;
	browser?: Browser;
	pollIntervalMs?: number;
}

function normalizeSignal(value: string): string {
	return value.trim().toLowerCase();
}

function isSensitiveReason(reason: string): boolean {
	const sensitivePattern =
		/\b(sign[\s-]?in|login|log[\s-]?in|password|passcode|otp|2fa|two[-\s]?factor|verification|verify|payment|card|credit|debit|cvv|checkout|billing|bank|ssn|security code)\b/i;
	return sensitivePattern.test(reason);
}

export function validateUserTakeoverReason(reason: string): string {
	const normalizedReason = reason.trim();
	if (!normalizedReason) {
		throw new Error(
			'user_takeover tool call requires a non-empty "reason" string',
		);
	}
	if (!isSensitiveReason(normalizedReason)) {
		throw new Error(
			'user_takeover reason must describe a sensitive interaction (e.g. sign-in, password, payment, OTP/2FA).',
		);
	}
	return normalizedReason;
}

async function readSignalFromStdin(question: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) =>
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		}),
	);
}

async function evaluateInPage(
	browser: Browser,
	expression: string,
): Promise<unknown> {
	const { result, exceptionDetails } = await browser.Runtime.evaluate({
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (exceptionDetails) {
		throw new Error(exceptionDetails.text || "Browser evaluation failed.");
	}
	return result.value;
}

function buildOverlayScript(reason: string, resumeSignal: string): string {
	return `(() => {
		const overlayId = ${JSON.stringify(OVERLAY_ID)};
		const resumeFlagKey = ${JSON.stringify(RESUME_FLAG_KEY)};
		const prunedAttributeName = ${JSON.stringify(PRUNED_ATTRIBUTE_NAME)};
		const takeoverStyleCacheAttributeName = ${JSON.stringify(TAKEOVER_STYLE_CACHE_ATTRIBUTE_NAME)};
		const takeoverStylePresentAttributeName = ${JSON.stringify(TAKEOVER_STYLE_PRESENT_ATTRIBUTE_NAME)};
		const reason = ${JSON.stringify(reason)};
		const resumeSignal = ${JSON.stringify(resumeSignal)};
		const revealPrunedElements = () => {
			const prunedElements = Array.from(
				document.querySelectorAll('[' + prunedAttributeName + '="true"]'),
			);
			for (const element of prunedElements) {
				if (!element.hasAttribute(takeoverStylePresentAttributeName)) {
					element.setAttribute(
						takeoverStylePresentAttributeName,
						element.hasAttribute("style") ? "true" : "false",
					);
					element.setAttribute(
						takeoverStyleCacheAttributeName,
						element.getAttribute("style") || "",
					);
				}
				const existingStyle = element.getAttribute("style") || "";
				const sanitizedStyle = existingStyle
					.replace(/\\bopacity\\s*:\\s*[^;]+;?/gi, "")
					.replace(/\\bvisibility\\s*:\\s*[^;]+;?/gi, "")
					.trim();
				const suffix =
					sanitizedStyle.length === 0 || sanitizedStyle.endsWith(";") ? "" : ";";
				element.setAttribute(
					"style",
					sanitizedStyle +
						suffix +
						" opacity: 1 !important; visibility: visible !important;",
				);
			}
		};
		const existing = document.getElementById(overlayId);
		revealPrunedElements();
		if (existing) {
			const reasonNode = existing.querySelector("[data-ba-user-takeover-reason]");
			if (reasonNode) reasonNode.textContent = reason;
			return true;
		}

		const overlay = document.createElement("div");
		overlay.id = overlayId;
		overlay.setAttribute("data-ba-ignore", "true");
		overlay.style.position = "fixed";
		overlay.style.top = "20px";
		overlay.style.left = "50%";
		overlay.style.transform = "translateX(-50%)";
		overlay.style.zIndex = "2147483647";
		overlay.style.display = "flex";
		overlay.style.alignItems = "center";
		overlay.style.gap = "16px";
		overlay.style.padding = "16px 18px 16px 22px";
		overlay.style.borderRadius = "999px";
		overlay.style.background = "rgba(17, 24, 39, 0.72)";
		overlay.style.border = "1px solid rgba(255, 255, 255, 0.14)";
		overlay.style.color = "#F9FAFB";
		overlay.style.boxShadow = "0 22px 50px rgba(15, 23, 42, 0.28)";
		overlay.style.backdropFilter = "blur(18px)";
		overlay.style.webkitBackdropFilter = "blur(18px)";
		overlay.style.fontFamily = "ui-sans-serif, system-ui, sans-serif";
		overlay.style.maxWidth = "min(calc(100vw - 24px), 820px)";
		overlay.style.pointerEvents = "auto";
		overlay.style.cursor = "grab";
		overlay.style.userSelect = "none";
		overlay.style.touchAction = "none";

		const label = document.createElement("div");
		label.style.display = "flex";
		label.style.flexDirection = "column";
		label.style.gap = "4px";
		label.style.minWidth = "0";

		const title = document.createElement("strong");
		title.textContent = "User takeover required";
		title.style.fontSize = "14px";
		title.style.lineHeight = "1.2";

		const subtitle = document.createElement("span");
		subtitle.setAttribute("data-ba-user-takeover-reason", "true");
		subtitle.textContent = reason;
		subtitle.style.fontSize = "12px";
		subtitle.style.lineHeight = "1.2";
		subtitle.style.color = "rgba(249, 250, 251, 0.76)";

		label.appendChild(title);
		label.appendChild(subtitle);

		const button = document.createElement("button");
		button.type = "button";
		button.setAttribute("aria-label", "Resume Agent");
		button.style.display = "inline-flex";
		button.style.alignItems = "center";
		button.style.gap = "8px";
		button.style.border = "0";
		button.style.borderRadius = "999px";
		button.style.padding = "12px 16px";
		button.style.background = "#F59E0B";
		button.style.color = "#111827";
		button.style.fontWeight = "700";
		button.style.fontSize = "12px";
		button.style.cursor = "pointer";
		button.style.whiteSpace = "nowrap";
		button.style.boxShadow = "inset 0 0 0 1px rgba(255,255,255,0.24)";
		button.style.flexShrink = "0";
		button.onmouseenter = () => {
			button.style.background = "#FBBF24";
		};
		button.onmouseleave = () => {
			button.style.background = "#F59E0B";
		};
		button.onclick = () => {
			window[resumeFlagKey] = resumeSignal;
		};

		const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		icon.setAttribute("viewBox", "0 0 24 24");
		icon.setAttribute("width", "14");
		icon.setAttribute("height", "14");
		icon.setAttribute("aria-hidden", "true");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", "M8 5.14v13.72a1 1 0 0 0 1.53.85l10.2-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z");
		path.setAttribute("fill", "currentColor");
		icon.appendChild(path);

		const text = document.createElement("span");
		text.textContent = "Resume Agent";

		button.appendChild(icon);
		button.appendChild(text);
		overlay.appendChild(label);
		overlay.appendChild(button);

		let dragOffsetX = 0;
		let dragOffsetY = 0;
		let dragging = false;

		const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
		const moveOverlay = (clientX, clientY) => {
			const rect = overlay.getBoundingClientRect();
			const maxLeft = Math.max(12, window.innerWidth - rect.width - 12);
			const maxTop = Math.max(12, window.innerHeight - rect.height - 12);
			const left = clamp(clientX - dragOffsetX, 12, maxLeft);
			const top = clamp(clientY - dragOffsetY, 12, maxTop);
			overlay.style.left = left + "px";
			overlay.style.top = top + "px";
			overlay.style.transform = "none";
		};

		const stopDragging = () => {
			dragging = false;
			overlay.style.cursor = "grab";
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", stopDragging);
		};

		const handlePointerMove = (event) => {
			if (!dragging) return;
			moveOverlay(event.clientX, event.clientY);
		};

		overlay.addEventListener("pointerdown", (event) => {
			if (event.target && button.contains(event.target)) {
				return;
			}
			const rect = overlay.getBoundingClientRect();
			dragging = true;
			dragOffsetX = event.clientX - rect.left;
			dragOffsetY = event.clientY - rect.top;
			overlay.style.cursor = "grabbing";
			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", stopDragging);
		});

		document.body.appendChild(overlay);
		return true;
	})()`;
}

async function ensureTakeoverOverlay(
	browser: Browser,
	reason: string,
	resumeSignal: string,
): Promise<void> {
	await evaluateInPage(browser, buildOverlayScript(reason, resumeSignal));
}

async function clearTakeoverOverlay(browser: Browser): Promise<void> {
	await evaluateInPage(
		browser,
		`(() => {
			const overlay = document.getElementById(${JSON.stringify(OVERLAY_ID)});
			if (overlay) overlay.remove();
			const prunedAttributeName = ${JSON.stringify(PRUNED_ATTRIBUTE_NAME)};
			const takeoverStyleCacheAttributeName = ${JSON.stringify(TAKEOVER_STYLE_CACHE_ATTRIBUTE_NAME)};
			const takeoverStylePresentAttributeName = ${JSON.stringify(TAKEOVER_STYLE_PRESENT_ATTRIBUTE_NAME)};
			const prunedElements = Array.from(
				document.querySelectorAll('[' + prunedAttributeName + '="true"]'),
			);
			for (const element of prunedElements) {
				const hadOriginalStyle =
					element.getAttribute(takeoverStylePresentAttributeName) === "true";
				const cachedStyle =
					element.getAttribute(takeoverStyleCacheAttributeName) || "";
				if (hadOriginalStyle) {
					element.setAttribute("style", cachedStyle);
				} else {
					element.removeAttribute("style");
				}
				element.removeAttribute(takeoverStyleCacheAttributeName);
				element.removeAttribute(takeoverStylePresentAttributeName);
			}
			delete window[${JSON.stringify(RESUME_FLAG_KEY)}];
			return true;
		})()`,
	).catch(() => undefined);
}

async function checkBrowserResumeSignal(
	browser: Browser,
	resumeSignal: string,
): Promise<boolean> {
	const value = await evaluateInPage(
		browser,
		`(() => window[${JSON.stringify(RESUME_FLAG_KEY)}] ?? null)()`,
	).catch(() => null);
	return normalizeSignal(typeof value === "string" ? value : "") === resumeSignal;
}

export async function waitForUserTakeoverSignal(
	options: WaitForUserTakeoverSignalOptions,
): Promise<void> {
	const log = options.log ?? console.log;
	const readSignal = options.readSignal ?? readSignalFromStdin;
	const resumeSignal = normalizeSignal(options.resumeSignal || DEFAULT_SIGNAL);
	const reason = validateUserTakeoverReason(options.reason);
	const pollIntervalMs = options.pollIntervalMs ?? OVERLAY_POLL_MS;

	log(`       [user_takeover] Reason: ${reason}`);
	if (options.browser) {
		log(
			`       [user_takeover] Please take control of the browser now. Click "Resume Agent" in the page overlay when you are ready for automation to continue.`,
		);
		while (true) {
			await ensureTakeoverOverlay(options.browser, reason, resumeSignal);
			if (await checkBrowserResumeSignal(options.browser, resumeSignal)) {
				await clearTakeoverOverlay(options.browser);
				log(
					`       [user_takeover] Resuming automation after in-browser "Resume Agent" click.`,
				);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}

	log(
		`       [user_takeover] Please take control of the browser now. Type "${resumeSignal}" when you are ready for automation to continue.`,
	);
	while (true) {
		const answer = await readSignal(
			`[user_takeover] Type "${resumeSignal}" to resume automation: `,
		);
		if (normalizeSignal(answer) === resumeSignal) {
			log(
				`       [user_takeover] Resuming automation after user signal "${resumeSignal}".`,
			);
			return;
		}
		log(
			`       [user_takeover] Received "${answer || "(empty)"}". Type "${resumeSignal}" when ready.`,
		);
	}
}
