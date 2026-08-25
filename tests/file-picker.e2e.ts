import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { close, getSemanticProjection, launch } from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

function getFilePickerFixtureFileUrl(): string {
	return pathToFileURL(
		path.resolve(process.cwd(), "assets", "file-picker-fixture.html"),
	).href;
}

async function refByName(browser: Browser, name: string): Promise<string> {
	const projection = await getSemanticProjection(browser);
	const line = projection
		.split("\n")
		.find(
			(candidate) =>
				candidate.includes(`name=${JSON.stringify(name)}`) &&
				/\bref="/.test(candidate),
		);
	const ref = line && /\bref="([^"]+)"/.exec(line)?.[1];
	assert.isString(ref, `missing ${name} in semantic projection:\n${projection}`);
	return ref!;
}

async function runPlainClickGuardTest(params: {
	buttonName: string;
	expectStoppedPropagation?: boolean;
}): Promise<void> {
	const workspaceDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "browser-agent-file-picker-workspace-"),
	);
	const profileDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "browser-agent-file-picker-profile-"),
	);
	const downloadsDir = path.join(workspaceDir, "downloads");
	fs.mkdirSync(downloadsDir, { recursive: true });
	fs.writeFileSync(path.join(workspaceDir, "must-not-upload.txt"), "private");

	let browser: Browser | null = null;
	try {
		browser = await launch(
			undefined,
			false,
			undefined,
			downloadsDir,
			profileDir,
		);
		await browser.Page.navigate({ url: getFilePickerFixtureFileUrl() });
		await browser.Page.loadEventFired();
		const ref = await refByName(browser, params.buttonName);

		const execution = await executeActions({
			b: browser,
			actions: [{ type: "click", ref }],
			openTabs: [],
			memoryFile: path.join(workspaceDir, "memory.txt"),
			fileWorkspaceRoot: workspaceDir,
		});

		assert.lengthOf(execution.interactionErrors, 1);
		assert.include(execution.interactionErrors[0] ?? "", "was canceled");
		assert.include(execution.interactionErrors[0] ?? "", "Use upload_files");

		const { result } = await browser.Runtime.evaluate({
			expression: `(() => ({
        selectedFileNames: window.__selectedFileNames || [],
        filePickerButtonClicks: window.__filePickerButtonClicks || 0,
        stoppedPropagation: Boolean(window.__stoppedFilePickerPropagation)
      }))()`,
			returnByValue: true,
		});
		const state = (result.value ?? {}) as {
			selectedFileNames?: string[];
			filePickerButtonClicks?: number;
			stoppedPropagation?: boolean;
		};
		assert.deepEqual(state.selectedFileNames, []);
		assert.isAtLeast(state.filePickerButtonClicks ?? 0, 1);
		if (params.expectStoppedPropagation) {
			assert.isTrue(state.stoppedPropagation);
		}
	} finally {
		if (browser) await close(browser);
		fs.rmSync(workspaceDir, { recursive: true, force: true });
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

describe("file picker e2e", function () {
	this.timeout(90_000);

	it("cancels a native picker opened by plain click without selecting a workspace file", async () => {
		await runPlainClickGuardTest({ buttonName: "Choose file" });
	});

	it("still guards a picker when the page stops click propagation", async () => {
		await runPlainClickGuardTest({
			buttonName: "Choose file and stop propagation",
			expectStoppedPropagation: true,
		});
	});
});
