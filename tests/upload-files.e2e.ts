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
});
