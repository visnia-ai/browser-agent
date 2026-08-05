import * as path from "path";
import * as os from "os";

export interface BrowserAgentArtifactDirectories {
	stepsDir: string;
	contextDir: string;
}

export function getDefaultBrowserAgentArtifactDirectories(
	basePath = path.join(os.tmpdir(), "browser-agent"),
): BrowserAgentArtifactDirectories {
	return {
		stepsDir: path.join(basePath, "steps"),
		contextDir: path.join(basePath, "context"),
	};
}

// Directory paths
export const { stepsDir: STEPS_DIR, contextDir: CONTEXT_DIR } =
	getDefaultBrowserAgentArtifactDirectories();
export const LOGS_DIR = path.join(os.tmpdir(), "browser-agent", "logs");

// DOM simplification constants
export const SKIP_TAGS = new Set([
	"SCRIPT",
	"STYLE",
	"META",
	"LINK",
	"NOSCRIPT",
	"SVG",
	"PATH",
	"BR",
	"HR",
	"HEAD",
]);

export const NATIVE_INTERACTIVE = new Set([
	"A",
	"BUTTON",
	"INPUT",
	"SELECT",
	"TEXTAREA",
	"DETAILS",
	"SUMMARY",
]);

export const DOM_INTERACTIVE_ROLES = new Set([
	"button",
	"link",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"checkbox",
	"radio",
	"switch",
	"slider",
	"spinbutton",
	"combobox",
	"searchbox",
	"textbox",
	"listbox",
	"treeitem",
]);

export const KEEP_ATTRS = new Set([
	"href",
	"type",
	"role",
	"aria-label",
	"title",
	"placeholder",
	"name",
	"value",
	"for",
	"action",
	"method",
]);

// Computed style indices (must match the order passed to captureSnapshot)
export const STYLE_DISPLAY = 0;
export const STYLE_VISIBILITY = 1;
export const STYLE_OPACITY = 2;
export const STYLE_CURSOR = 3;
export const STYLE_OVERFLOW_X = 4;
export const STYLE_OVERFLOW_Y = 5;
export const STYLE_BACKGROUND_IMAGE = 6;

/** Cursors that imply the element is not receptive to clicks; still surfaced as interactive with a caveat in the simplified DOM. */
export const NO_CLICK_ALLOWED_CURSORS = new Set(["not-allowed", "no-drop"]);

export const OPACITY_FOR_PRUNED_NODES = "0";
