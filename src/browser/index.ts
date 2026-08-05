// Re-export types
export type { Browser, Tab } from "./types.js";
export type { BrowserRemoteInput, BrowserViewportMetrics } from "./types.js";

// Re-export browser functions
export {
	launch,
	resolveChromeExecutablePath,
	ChromeExecutableNotFoundError,
	connectToTarget,
	navigate,
	isSupportedInBrowserNavigateUrl,
	downloadCurrentFile,
	consumePrintRequestsAndSavePdfs,
	installPrintInterception,
	getHTML,
	getURL,
	getLocale,
	execJS,
	dropdownSelect,
	click,
	longPress,
	clickAndAutoUploadIfFileChooser,
	scroll,
	pasteFile,
	uploadFiles,
	assertPasswordInputRef,
	ensureCheckboxChecked,
	readIdentifierInputByRef,
	findMostParentBid,
	findTopParentBids,
	findScreenshotCaptureBids,
	pruneLiveDomByBids,
	pruneLiveDomByIdentifiers,
	unpruneLiveDom,
	captureScreenshotWithBidBorders,
	type,
	screenshotElementInIsolatedPage,
	listTabs,
	newTab,
	switchTab,
	closeTab,
	waitForAllOpenTabsToSettle,
	hideWindow,
	showWindow,
	capturePreviewDataUrl,
	downsampleScreenshotByFactor,
	getWindowDevicePixelRatio,
	getViewportMetrics,
	dispatchRemoteInput,
	close,
	sleep,
} from "./browser.js";
export { getPageFaviconForPreview } from "./favicon-preview.js";

// Re-export DOM simplification
export {
	getSimplifiedDOM,
	pruneLargeHiddenHierarchies,
	CONTEXT_DIR,
} from "./simplify-dom.js";
export { getSemanticProjection } from "./semantic-projection.js";
export type { SemanticProjectionOptions } from "./semantic-projection.js";
export {
	minifySimplifiedDOM,
	unminifySimplifiedDOM,
} from "./simplified-dom-minifier.js";

// Re-export DOM diff
export { computeDomDiff } from "./dom-diff.js";
