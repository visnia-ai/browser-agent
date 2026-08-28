import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import * as chromeLauncher from "chrome-launcher";
import CDP from "chrome-remote-interface";
import { assert } from "chai";
import { describe, it } from "mocha";
import {
	buildChromeLaunchFlags,
	connectToTarget,
} from "../src/browser/browser.js";
import {
	configFeatureFlags,
	mergeConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { createDefaultCoreDeps } from "../src/core/deps.js";
import { closeSession, createSession, step } from "../src/core/index.js";

async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req, res) => {
		const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
		const title = pathname === "/editor" ? "Editor" : "Responder";
		const html = `<!doctype html><title>${title}</title><h1>${title}</h1>`;
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"content-length": String(Buffer.byteLength(html)),
		});
		res.end(html);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function getAvailablePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}

describe("switch_tab e2e", function () {
	this.timeout(60_000);

	it("keeps an explicit switch from a responder tab back to its editor", async () => {
		const { server, baseUrl } = await startFixtureServer();
		const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-agent-switch-tab-"));
		const userDataDir = path.join(testRoot, "chrome-profile");
		const downloadDir = path.join(testRoot, "downloads");
		fs.mkdirSync(userDataDir, { recursive: true });
		fs.mkdirSync(downloadDir, { recursive: true });

		const featureFlags = mergeConfigFeatureFlags(configFeatureFlags, {
			preStepScreenshotInLatestUserPrompt: false,
		});
		const deps = createDefaultCoreDeps({ featureFlags });
		const port = await getAvailablePort();
		let launchedChrome: chromeLauncher.LaunchedChrome | undefined;
		deps.isPortInUse = async () => false;
		deps.launchBrowser = async (
			requestedPort,
			headless,
			_proxy,
			requestedDownloadDir,
			requestedUserDataDir,
		) => {
			launchedChrome = await chromeLauncher.launch({
				port: requestedPort,
				ignoreDefaultFlags: true,
				chromeFlags: buildChromeLaunchFlags({
					headless,
					userDataDirOverride: requestedUserDataDir,
				}),
				userDataDir: requestedUserDataDir,
			});
			const targets = await CDP.List({ host: "127.0.0.1", port: launchedChrome.port });
			const initialTarget = targets.find((target) => target.type === "page");
			assert.isDefined(initialTarget);
			return await connectToTarget({
				port: launchedChrome.port,
				targetId: initialTarget!.id,
				downloadDir: requestedDownloadDir,
				userDataDir: requestedUserDataDir,
				closeTransport: async () => await launchedChrome?.kill(),
			});
		};

		try {
			await createSession(deps, {
				port,
				headless: true,
				url: `${baseUrl}/editor`,
				downloadDir,
				userDataDir,
				forceRestart: true,
			});
			const session = deps.registry.get(port)!;
			await step(deps, {
				mode: "create_prompt_for_step",
				port,
				userTask: "Return from responder to editor",
				stepsHistory: [],
			});

			await session.browser.Target.createTarget({ url: `${baseUrl}/responder` });
			const responderPrompt = await step(deps, {
				mode: "create_prompt_for_step",
				port,
				userTask: "Return from responder to editor",
				stepsHistory: [],
			});
			assert.strictEqual(responderPrompt.mode, "create_prompt_for_step");
			assert.strictEqual(responderPrompt.context.current_url, `${baseUrl}/responder`);
			const responderIndex = responderPrompt.context.open_tabs.indexOf("Responder");
			const editorIndex = responderPrompt.context.open_tabs.indexOf("Editor");
			assert.isAtLeast(responderIndex, 0);
			assert.isAtLeast(editorIndex, 0);
			assert.strictEqual(
				responderPrompt.context.current_tab,
				responderIndex,
				"currentTab must identify the tab whose URL and projection are active",
			);
			assert.notStrictEqual(editorIndex, responderPrompt.context.current_tab);

			await step(deps, {
				mode: "browse",
				port,
				generatedActions: [{ type: "switch_tab", index: editorIndex }],
			});
			assert.strictEqual(await deps.getCurrentURL(session.browser), `${baseUrl}/editor`);

			const editorPrompt = await step(deps, {
				mode: "create_prompt_for_step",
				port,
				userTask: "Return from responder to editor",
				stepsHistory: [],
			});
			assert.strictEqual(editorPrompt.mode, "create_prompt_for_step");
			assert.strictEqual(editorPrompt.context.current_url, `${baseUrl}/editor`);
		} finally {
			if (deps.registry.get(port)) await closeSession(deps, port);
			else await launchedChrome?.kill();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			fs.rmSync(testRoot, { recursive: true, force: true });
		}
	});
});
