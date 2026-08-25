import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { close, getSemanticProjection, launch } from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

async function startFixtureServer(): Promise<{
	server: Server;
	baseUrl: string;
}> {
	const server = createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}

		const html = `<!doctype html>
<html>
  <body>
    <main>
      <h1>Upload Fixture</h1>
      <section>
        <label for="direct-input">Direct input</label>
        <input id="direct-input" type="file" multiple />
        <div id="direct-result"></div>
      </section>
      <section>
        <button id="trigger-hidden-input" type="button">Choose hidden input</button>
        <input id="hidden-input" type="file" style="display:none" />
        <div id="hidden-result"></div>
      </section>
    </main>
    <script>
      const directInput = document.getElementById("direct-input");
      const hiddenInput = document.getElementById("hidden-input");
      const directResult = document.getElementById("direct-result");
      const hiddenResult = document.getElementById("hidden-result");
      const renderNames = (files) => Array.from(files || []).map((file) => file.name).join(", ");

      directInput.addEventListener("change", () => {
        directResult.textContent = renderNames(directInput.files);
      });
      hiddenInput.addEventListener("change", () => {
        hiddenResult.textContent = renderNames(hiddenInput.files);
      });
      document
        .getElementById("trigger-hidden-input")
        .addEventListener("click", () => hiddenInput.click());
    </script>
  </body>
</html>`;

		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(html);
	});

	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const address = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function startIntermediatePickerServers(params: {
	mode: "iframe" | "popup";
	controlNames?: string[];
}): Promise<{
	hostServer: Server;
	pickerServer: Server;
	hostUrl: string;
}> {
	const pickerServer = createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		const controlNames = params.controlNames ?? ["Browse"];
		const controls = controlNames
			.map(
				(name, index) =>
					`<button data-picker-control type="button" id="picker-control-${index}">${name}</button>`,
			)
			.join("\n");
		const html = `<!doctype html>
<html>
  <body>
    <main role="dialog" aria-label="Insert file">
      <h1>Insert file</h1>
      <p>Upload one supported file.</p>
      ${controls}
      <input id="picker-input" type="file" hidden />
      <p id="picker-status">Waiting for a file</p>
    </main>
    <script>
      const input = document.getElementById("picker-input");
      const status = document.getElementById("picker-status");
      document.querySelectorAll("[data-picker-control]").forEach((control) => {
        control.addEventListener("click", () => input.click());
      });
      input.addEventListener("change", () => {
        const name = input.files?.[0]?.name || "";
        status.textContent = "uploading: " + name;
        const recipient = window.opener || parent;
        recipient.postMessage({ type: "fixture-upload", state: "uploading", name }, "*");
        setTimeout(() => {
          status.textContent = "committed: " + name;
          recipient.postMessage({ type: "fixture-upload", state: "committed", name }, "*");
          if (window.opener) setTimeout(() => window.close(), 100);
        }, 150);
      });
    </script>
  </body>
</html>`;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(html);
	});
	await new Promise<void>((resolve) =>
		pickerServer.listen(0, "127.0.0.1", resolve),
	);
	const pickerAddress = pickerServer.address() as AddressInfo;
	const pickerUrl = `http://127.0.0.1:${pickerAddress.port}`;

	const hostServer = createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		const pickerMarkup =
			params.mode === "iframe"
				? `<dialog id="picker-dialog" aria-label="Insert file">
        <iframe title="File picker" src="${pickerUrl}/picker"></iframe>
      </dialog>`
				: "";
		const openPicker =
			params.mode === "iframe"
				? "dialog.showModal()"
				: `window.open(${JSON.stringify(`${pickerUrl}/picker`)}, "OnePick", "popup")`;
		const closePicker =
			params.mode === "iframe" ? "dialog.close();" : "";
		const html = `<!doctype html>
<html>
  <body>
    <main>
      <h1>Google-style Form Fixture</h1>
      <button id="add-file" type="button">Add file</button>
      ${pickerMarkup}
      <p id="upload-state">no file selected</p>
      <button id="submit" type="button" disabled>Submit</button>
      <button id="responses" type="button">Responses</button>
      <p id="response-state">No responses</p>
    </main>
    <script>
      const dialog = document.getElementById("picker-dialog");
      const uploadState = document.getElementById("upload-state");
      const submit = document.getElementById("submit");
      const responseState = document.getElementById("response-state");
      let uploadedName = "";
      let submittedName = "";
      document.getElementById("add-file").addEventListener("click", () => ${openPicker});
      window.addEventListener("message", (event) => {
        if (event.origin !== ${JSON.stringify(pickerUrl)}) return;
        if (event.data?.type !== "fixture-upload") return;
        uploadedName = String(event.data.name || "");
        uploadState.textContent = event.data.state + ": " + uploadedName;
        if (event.data.state === "committed") {
          submit.disabled = false;
          ${closePicker}
        }
      });
      submit.addEventListener("click", () => {
        submittedName = uploadedName;
        responseState.textContent = "submitted: " + submittedName;
      });
      document.getElementById("responses").addEventListener("click", () => {
        responseState.textContent = submittedName
          ? "verified response: " + submittedName
          : "No responses";
      });
    </script>
  </body>
</html>`;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(html);
	});
	await new Promise<void>((resolve) =>
		hostServer.listen(0, "127.0.0.1", resolve),
	);
	const hostAddress = hostServer.address() as AddressInfo;
	return {
		hostServer,
		pickerServer,
		hostUrl: `http://127.0.0.1:${hostAddress.port}`,
	};
}

async function stopServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

async function readResultText(params: {
	browser: Browser;
	elementId: string;
}): Promise<string> {
	const { result } = await params.browser.Runtime.evaluate({
		expression: `document.getElementById(${JSON.stringify(params.elementId)})?.textContent || ""`,
		returnByValue: true,
	});
	return String(result.value || "");
}

async function refByName(browser: Browser, name: string): Promise<string> {
	const projection = await getSemanticProjection(browser, {
		omitHrefs: false,
	});
	const line = projection
		.split("\n")
		.find(
			(candidate) =>
				candidate.includes(`name=${JSON.stringify(name)}`) &&
				/\bref="/.test(candidate),
		);
	const ref = line && /\bref="([^"]+)"/.exec(line)?.[1];
	assert.isString(
		ref,
		`missing ${name} in semantic projection:\n${projection}`,
	);
	return ref!;
}

async function runIntermediatePickerFlow(
	mode: "iframe" | "popup",
): Promise<void> {
	const { hostServer, pickerServer, hostUrl } =
		await startIntermediatePickerServers({ mode });
	const workspaceDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "upload-files-intermediate-workspace-"),
	);
	const profileDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "upload-files-intermediate-profile-"),
	);
	const downloadsDir = path.join(workspaceDir, "downloads");
	fs.mkdirSync(downloadsDir, { recursive: true });
	fs.writeFileSync(path.join(workspaceDir, "expected-photo.jpg"), "image");

	let browser: Browser | null = null;
	try {
		browser = await launch(
			undefined,
			true,
			undefined,
			downloadsDir,
			profileDir,
		);
		await browser.Page.navigate({ url: hostUrl });
		await browser.Page.loadEventFired();
		const addFileRef = await refByName(browser, "Add file");

		const uploadResult = await executeActions({
			b: browser,
			actions: [
				{
					type: "upload_files",
					ref: addFileRef,
					paths: ["./expected-photo.jpg"],
				},
			],
			openTabs: [],
			memoryFile: path.join(workspaceDir, "memory.txt"),
			fileWorkspaceRoot: workspaceDir,
		});
		assert.deepEqual(uploadResult.interactionErrors, []);
		assert.lengthOf(uploadResult.toolObservations, 1);
		assert.include(
			uploadResult.toolObservations[0] ?? "",
			'"paths":["./expected-photo.jpg"]',
		);

		await new Promise((resolve) => setTimeout(resolve, 250));
		const submitRef = await refByName(browser, "Submit");
		const responsesRef = await refByName(browser, "Responses");
		const submitResult = await executeActions({
			b: browser,
			actions: [
				{ type: "click", ref: submitRef },
				{ type: "click", ref: responsesRef },
			],
			openTabs: [],
			memoryFile: path.join(workspaceDir, "memory.txt"),
			fileWorkspaceRoot: workspaceDir,
		});
		assert.deepEqual(submitResult.interactionErrors, []);
		assert.strictEqual(
			await readResultText({
				browser,
				elementId: "response-state",
			}),
			"verified response: expected-photo.jpg",
		);
	} finally {
		if (browser) await close(browser);
		await stopServer(hostServer);
		await stopServer(pickerServer);
		fs.rmSync(workspaceDir, { recursive: true, force: true });
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

async function runRejectedIntermediatePicker(
	controlNames: string[],
): Promise<{ error: string; uploadState: string }> {
	const { hostServer, pickerServer, hostUrl } =
		await startIntermediatePickerServers({
			mode: "iframe",
			controlNames,
		});
	const workspaceDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "upload-files-rejected-workspace-"),
	);
	const profileDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "upload-files-rejected-profile-"),
	);
	const downloadsDir = path.join(workspaceDir, "downloads");
	fs.mkdirSync(downloadsDir, { recursive: true });
	fs.writeFileSync(path.join(workspaceDir, "must-not-upload.jpg"), "image");

	let browser: Browser | null = null;
	try {
		browser = await launch(
			undefined,
			true,
			undefined,
			downloadsDir,
			profileDir,
		);
		await browser.Page.navigate({ url: hostUrl });
		await browser.Page.loadEventFired();
		const addFileRef = await refByName(browser, "Add file");
		const result = await executeActions({
			b: browser,
			actions: [
				{
					type: "upload_files",
					ref: addFileRef,
					paths: ["./must-not-upload.jpg"],
				},
			],
			openTabs: [],
			memoryFile: path.join(workspaceDir, "memory.txt"),
			fileWorkspaceRoot: workspaceDir,
		});
		assert.lengthOf(result.interactionErrors, 1);
		return {
			error: result.interactionErrors[0] ?? "",
			uploadState: await readResultText({
				browser,
				elementId: "upload-state",
			}),
		};
	} finally {
		if (browser) await close(browser);
		await stopServer(hostServer);
		await stopServer(pickerServer);
		fs.rmSync(workspaceDir, { recursive: true, force: true });
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

describe("upload_files e2e", function () {
	this.timeout(60_000);

	it("uploads workspace files through direct file inputs and chooser-trigger buttons", async () => {
		const { server, baseUrl } = await startFixtureServer();
		const workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "upload-files-workspace-"),
		);
		const downloadsDir = path.join(workspaceDir, "downloads");
		fs.mkdirSync(downloadsDir, { recursive: true });
		const directUploadPath = path.join(workspaceDir, "direct.txt");
		const hiddenUploadPath = path.join(downloadsDir, "hidden.txt");
		fs.writeFileSync(directUploadPath, "direct", "utf-8");
		fs.writeFileSync(hiddenUploadPath, "hidden", "utf-8");

		let browser: Browser | null = null;
		try {
			const userDataDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "upload-files-profile-"),
			);
			browser = await launch(
				undefined,
				true,
				undefined,
				downloadsDir,
				userDataDir,
			);
			await browser.Page.navigate({ url: baseUrl });
			await browser.Page.loadEventFired();
			const directInputRef = await refByName(browser, "Direct input");
			const hiddenInputTriggerRef = await refByName(
				browser,
				"Choose hidden input",
			);

			const directResult = await executeActions({
				b: browser,
				actions: [
					{
						type: "upload_files",
						ref: directInputRef,
						paths: ["./direct.txt"],
					},
				],
				openTabs: [],
				memoryFile: path.join(workspaceDir, "memory.txt"),
				fileWorkspaceRoot: workspaceDir,
			});
			assert.deepEqual(directResult.interactionErrors, []);
			assert.lengthOf(directResult.toolObservations, 1);
			assert.include(directResult.toolObservations[0] ?? "", '"state":"committed"');
			assert.strictEqual(
				await readResultText({
					browser,
					elementId: "direct-result",
				}),
				"direct.txt",
			);

			const hiddenResult = await executeActions({
				b: browser,
				actions: [
					{
						type: "upload_files",
						ref: hiddenInputTriggerRef,
						paths: ["./downloads/hidden.txt"],
					},
				],
				openTabs: [],
				memoryFile: path.join(workspaceDir, "memory.txt"),
				fileWorkspaceRoot: workspaceDir,
			});
			assert.deepEqual(hiddenResult.interactionErrors, []);
			assert.lengthOf(hiddenResult.toolObservations, 1);
			assert.include(hiddenResult.toolObservations[0] ?? "", '"state":"committed"');
			assert.strictEqual(
				await readResultText({
					browser,
					elementId: "hidden-result",
				}),
				"hidden.txt",
			);
		} finally {
			if (browser) {
				await close(browser);
			}
			await stopServer(server);
			fs.rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	for (const mode of ["iframe", "popup"] as const) {
		it(`uploads through one cross-origin intermediate ${mode} picker hop and verifies the submitted response`, async () => {
			await runIntermediatePickerFlow(mode);
		});
	}

	it("rejects an ambiguous intermediate picker without selecting a file", async () => {
		const result = await runRejectedIntermediatePicker([
			"Browse",
			"Select file",
		]);
		assert.include(result.error, "is ambiguous");
		assert.include(result.error, 'button "Browse"');
		assert.include(result.error, 'button "Select file"');
		assert.strictEqual(result.uploadState, "no file selected");
	});

	it("times out with the unsupported dialog controls seen", async () => {
		const result = await runRejectedIntermediatePicker(["Open local file"]);
		assert.include(result.error, "No supported one-hop");
		assert.include(result.error, 'controls seen: button "Open local file"');
		assert.strictEqual(result.uploadState, "no file selected");
	});
});
