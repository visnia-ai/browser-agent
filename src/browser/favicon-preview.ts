import type { Browser } from "./types.js";

/**
 * Resolves a favicon URL from the active document only (no network, no Electron host / IPC).
 * Returns `faviconHttpUrl` for the best matching `<link rel=…icon>` or `/favicon.ico` fallback.
 */
export async function getPageFaviconForPreview(
	b: Pick<Browser, "Runtime">,
): Promise<{ faviconHttpUrl?: string; faviconDataUrl?: string }> {
	const expression = `
(function () {
  try {
    var loc = document.location;
    if (!loc || loc.protocol === "about:" || loc.protocol === "data:") {
      return {};
    }
    var base = loc.href;
    var links = Array.prototype.slice.call(
      document.querySelectorAll(
        'link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"],link[rel="apple-touch-icon-precomposed"]'
      )
    );
    function score(el) {
      var rel = (el.getAttribute("rel") || "").toLowerCase();
      var sizes = el.getAttribute("sizes");
      var s = 0;
      if (rel.indexOf("apple-touch") !== -1) s += 20;
      if (sizes) {
        var m = /^(\\d+)x(\\d+)$/i.exec(String(sizes).trim());
        if (m) s += parseInt(m[1], 10) * parseInt(m[2], 10);
      } else if (rel.indexOf("icon") !== -1) s += 5;
      return s;
    }
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < links.length; i++) {
      var el = links[i];
      var href = el.getAttribute("href");
      if (!href || !String(href).trim()) continue;
      var sc = score(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
    if (best) {
      try {
        var absolute = new URL(best.getAttribute("href") || "", base).href;
        return { faviconHttpUrl: absolute };
      } catch (e) {}
    }
    try {
      return { faviconHttpUrl: new URL("/favicon.ico", base).href };
    } catch (e2) {}
    return {};
  } catch (e3) {
    return {};
  }
})()
`;

	const { result, exceptionDetails } = await b.Runtime.evaluate({
		expression,
		awaitPromise: false,
		returnByValue: true,
	});

	if (exceptionDetails) {
		return {};
	}

	const value = result?.value as
		| { faviconHttpUrl?: string; faviconDataUrl?: string }
		| undefined;
	if (!value || typeof value !== "object") {
		return {};
	}

	const out: { faviconHttpUrl?: string; faviconDataUrl?: string } = {};
	if (
		typeof value.faviconHttpUrl === "string" &&
		value.faviconHttpUrl.trim()
	) {
		out.faviconHttpUrl = value.faviconHttpUrl.trim();
	}
	if (
		typeof value.faviconDataUrl === "string" &&
		value.faviconDataUrl.startsWith("data:")
	) {
		out.faviconDataUrl = value.faviconDataUrl;
	}
	return out;
}
