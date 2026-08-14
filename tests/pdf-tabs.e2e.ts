import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";

import * as chromeLauncher from "chrome-launcher";
import CDP from "chrome-remote-interface";
import { assert } from "chai";
import { describe, it } from "mocha";
import {
	buildChromeLaunchFlags,
	connectToTarget,
} from "../src/browser/browser.js";
import { isPdfViewerTab } from "../src/browser/download-current-pdf.js";
import {
	configFeatureFlags,
	mergeConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { createDefaultCoreDeps } from "../src/core/deps.js";
import { closeSession, createSession, step } from "../src/core/index.js";
import type { Tab } from "../src/browser/types.js";

function createPdf(): Buffer {
	const pageContent =
		"BT /F1 18 Tf 72 720 Td (Browser agent PDF fixture) Tj ET\n";
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
		`4 0 obj\n<< /Length ${Buffer.byteLength(pageContent)} >>\nstream\n${pageContent}endstream\nendobj\n`,
		"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
	];
	let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
	const offsets: number[] = [];
	for (const object of objects) {
		offsets.push(Buffer.byteLength(body, "binary"));
		body += object;
	}
	const xrefOffset = Buffer.byteLength(body, "binary");
	body += `xref\n0 ${objects.length + 1}\n`;
	body += "0000000000 65535 f \n";
	for (const offset of offsets) {
		body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
	body += `startxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "binary");
}

async function startFixtureServer(): Promise<{
	server: Server;
	baseUrl: string;
}> {
	const pdf = createPdf();
	const server = createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/source") {
			const html =
				"<!doctype html><title>PDF Tab Source</title><main><h1>Source page</h1></main>";
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-length": String(Buffer.byteLength(html)),
			});
			res.end(html);
			return;
		}
		if (requestUrl.pathname === "/generated.pdf") {
			res.writeHead(200, {
				"content-type": "application/pdf",
				"content-disposition": 'inline; filename="generated.pdf"',
				"content-length": String(pdf.byteLength),
				"cache-control": "no-store",
			});
			res.end(pdf);
			return;
		}
		if (requestUrl.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		res.writeHead(404);
		res.end("not found");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

async function getAvailablePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	return port;
}

async function waitForTab(
	listTabs: () => Promise<Tab[]>,
	predicate: (tab: Tab) => boolean,
	timeoutMs = 10_000,
): Promise<Tab> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const tab = (await listTabs()).find(predicate);
		if (tab) return tab;
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Timed out waiting for the PDF viewer tab");
}

describe("PDF tabs e2e", function () {
	this.timeout(60_000);

	it("downloads a real PDF viewer tab but excludes it from openTabs", async () => {
		const { server, baseUrl } = await startFixtureServer();
		const testRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-agent-pdf-tabs-e2e-"),
		);
		const userDataDir = path.join(testRoot, "chrome-profile");
		const downloadDir = path.join(testRoot, "downloads");
		const profileDir = path.join(userDataDir, "Default");
		fs.mkdirSync(profileDir, { recursive: true });
		fs.writeFileSync(
			path.join(profileDir, "Preferences"),
			JSON.stringify({
				plugins: { always_open_pdf_externally: false },
			}),
		);

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
			const targets = await CDP.List({
				host: "127.0.0.1",
				port: launchedChrome.port,
			});
			const initialTarget = targets.find((target) => target.type === "page");
			assert.isDefined(initialTarget, "Chrome did not create an initial page");
			return await connectToTarget({
				port: launchedChrome.port,
				targetId: initialTarget!.id,
				downloadDir: requestedDownloadDir,
				userDataDir: requestedUserDataDir,
				closeTransport: async () => {
					await launchedChrome?.kill();
				},
			});
		};

		try {
			await createSession(deps, {
				port,
				headless: true,
				url: `${baseUrl}/source`,
				downloadDir,
				userDataDir,
				forceRestart: true,
			});
			const session = deps.registry.get(port)!;
			const sourceTabs = await deps.listTabs(session.browser);
			const sourceTab = sourceTabs.find(
				(tab) => tab.url === `${baseUrl}/source`,
			);
			assert.isDefined(sourceTab);
			session.previousStepTabs = sourceTabs;

			await session.browser.Target.createTarget({
				url: `${baseUrl}/generated.pdf`,
			});
			const pdfTab = await waitForTab(
				() => deps.listTabs(session.browser),
				(tab) =>
					tab.url === `${baseUrl}/generated.pdf` &&
					/generated\.pdf/i.test(tab.title),
			);
			assert.match(pdfTab.title, /generated\.pdf/i);
			assert.isTrue(isPdfViewerTab(pdfTab));

			const result = await step(deps, {
				mode: "create_prompt_for_step",
				port,
				userTask: "Read the source page without entering PDF viewers",
				stepsHistory: [],
			});

			assert.strictEqual(result.mode, "create_prompt_for_step");
			if (result.mode === "create_prompt_for_step") {
				assert.deepEqual(result.prompt.payload.openTabs, ["PDF Tab Source"]);
				assert.isUndefined(result.prompt.payload.newlyOpenedTabs);
				assert.deepEqual(result.context.open_tabs, ["PDF Tab Source"]);
				assert.strictEqual(result.context.current_tab, 0);
				assert.strictEqual(result.context.current_url, `${baseUrl}/source`);
			}
			assert.deepEqual(
				session.previousStepTabs?.map((tab) => tab.targetId).sort(),
				[sourceTab!.targetId, pdfTab.targetId].sort(),
			);
			assert.isTrue(
				fs.readdirSync(downloadDir).some((entry) => entry.endsWith(".pdf")),
				"the PDF viewer source should still be downloaded",
			);
		} finally {
			if (deps.registry.get(port)) {
				await closeSession(deps, port);
			} else {
				await launchedChrome?.kill();
			}
			await stopServer(server);
			fs.rmSync(testRoot, { recursive: true, force: true });
		}
	});
});
