import * as fs from "node:fs";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import {
	close,
	getSemanticProjection,
	getSimplifiedDOM,
	launch,
	navigate,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

const HTML_FILE = "scroll-lazy-fixture.html";
const JS_FILE = "scroll-lazy-fixture.js";

function readAsset(name: string): string {
	return fs.readFileSync(path.join(process.cwd(), "assets", name), "utf-8");
}

async function startFixtureServer(): Promise<{
	server: Server;
	baseUrl: string;
}> {
	const html = readAsset(HTML_FILE);
	const js = readAsset(JS_FILE);
	const server = createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		if (requestUrl.pathname === `/${HTML_FILE}`) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(html);
			return;
		}
		if (requestUrl.pathname === `/${JS_FILE}`) {
			res.writeHead(200, {
				"content-type": "application/javascript; charset=utf-8",
			});
			res.end(js);
			return;
		}
		if (requestUrl.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
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

describe("scroll lazy fixture e2e", function () {
	this.timeout(30_000);

	it("marks lazy scroll container as scroll-enabled/scrollable in simplified dom", async () => {
		const { server, baseUrl } = await startFixtureServer();
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, `${baseUrl}/${HTML_FILE}`);
			const simplifiedInitial = await getSimplifiedDOM(browser);
			const initialLines = simplifiedInitial
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const initialBothMarkerLines = initialLines.filter(
				(line) =>
					line.includes("scroll-enabled") &&
					line.includes("scrollable"),
			);

			assert.isAtLeast(
				initialBothMarkerLines.length,
				1,
				"initial lazy-scroll snapshot should expose both scroll markers",
			);
			const initial = await browser.Runtime.evaluate({
				expression: `(() => {
					const state = window.__lazyScrollFixtureState;
					if (!state) return { ready: false };
					return {
						ready: true,
						itemCount: state.itemCount,
						batchesLoaded: state.batchesLoaded,
						scrollable: state.scrollable,
					};
				})()`,
				returnByValue: true,
			});
			const initialValue = (initial.result.value ?? {}) as {
				ready?: boolean;
				itemCount?: number;
				batchesLoaded?: number;
				scrollable?: boolean;
			};
			assert.strictEqual(initialValue.ready, true);
			assert.isAtLeast(initialValue.itemCount ?? 0, 8);
			assert.strictEqual(initialValue.batchesLoaded, 0);
			assert.strictEqual(initialValue.scrollable, true);

			const beforeScroll = await browser.Runtime.evaluate({
				expression: `(() => {
          const el = document.querySelector('[data-testid="lazy-scroll-container"]');
          const state = window.__lazyScrollFixtureState;
          if (!(el instanceof HTMLElement) || !state) return null;
          return {
            scrollTop: el.scrollTop,
            nearBottomTriggers: state.nearBottomTriggers,
          };
        })()`,
				returnByValue: true,
			});
			const beforeValue = (beforeScroll.result.value ?? null) as {
				scrollTop?: number;
				nearBottomTriggers?: number;
			} | null;
			assert.isNotNull(beforeValue, "lazy scroll container should exist");
			const projection = await getSemanticProjection(browser);
			const scrollRef =
				/generic ref="([^"]+)"\n\s+text name="Lazy item 1\b/.exec(
					projection,
				)?.[1];
			assert.isString(
				scrollRef,
				`expected semantic lazy-scroll ref in ${projection}`,
			);

			const execution = await executeActions({
				b: browser,
				actions: [
					{
						type: "scroll",
						ref: scrollRef ?? "",
						deltaY: 600,
					},
					{
						type: "scroll",
						ref: scrollRef ?? "",
						deltaY: 600,
					},
				],
				openTabs: [],
				memoryFile: "/tmp/browser-agent-scroll-lazy-memory.txt",
			});
			assert.deepEqual(
				execution.interactionErrors,
				[],
				"scroll tool should execute without interaction errors",
			);

			const afterScrollProbe = await browser.Runtime.evaluate({
				expression: `(() => {
          const el = document.querySelector('[data-testid="lazy-scroll-container"]');
          const state = window.__lazyScrollFixtureState;
          if (!(el instanceof HTMLElement) || !state) return null;
          return {
            scrollTop: el.scrollTop,
            nearBottomTriggers: state.nearBottomTriggers,
          };
        })()`,
				returnByValue: true,
			});
			const afterScrollValue = (afterScrollProbe.result.value ??
				null) as {
				scrollTop?: number;
				nearBottomTriggers?: number;
			} | null;
			assert.isNotNull(afterScrollValue);
			assert.isAtLeast(
				Number(afterScrollValue?.scrollTop ?? 0),
				Number(beforeValue?.scrollTop ?? 0),
				"scroll tool should move lazy container position",
			);
			assert.isAtLeast(
				Number(afterScrollValue?.nearBottomTriggers ?? 0),
				Number(beforeValue?.nearBottomTriggers ?? 0),
				"scroll tool should trigger lazy fixture near-bottom logic",
			);

			for (let i = 0; i < 2; i++) {
				await browser.Runtime.evaluate({
					expression: `window.__lazyScrollFixtureState?.triggerLoadBatch?.()`,
					returnByValue: true,
					awaitPromise: true,
				});
			}

			const simplifiedAfterLoad = await getSimplifiedDOM(browser);
			const afterLines = simplifiedAfterLoad
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const afterBothMarkerLines = afterLines.filter(
				(line) =>
					line.includes("scroll-enabled") &&
					line.includes("scrollable"),
			);

			assert.isAtLeast(
				afterBothMarkerLines.length,
				1,
				"after lazy-load updates, simplified DOM should still expose both scroll markers",
			);

			const statusLine = afterLines.find((line) =>
				line.includes("items="),
			);
			assert.isDefined(
				statusLine,
				"status text should be present in simplified DOM",
			);
			assert.notInclude(
				statusLine ?? "",
				"scroll-enabled",
				"status text line should not be marked scroll-enabled",
			);
			assert.notInclude(
				statusLine ?? "",
				"scrollable",
				"status text line should not be marked scrollable",
			);

			const after = await browser.Runtime.evaluate({
				expression: `(() => {
					const state = window.__lazyScrollFixtureState;
					if (!state) return { ready: false };
					return {
						ready: true,
						itemCount: state.itemCount,
						batchesLoaded: state.batchesLoaded,
						nearBottomTriggers: state.nearBottomTriggers,
					};
				})()`,
				returnByValue: true,
			});
			const afterValue = (after.result.value ?? {}) as {
				ready?: boolean;
				itemCount?: number;
				batchesLoaded?: number;
				nearBottomTriggers?: number;
			};
			assert.strictEqual(afterValue.ready, true);
			assert.isAtLeast(afterValue.batchesLoaded ?? 0, 2);
			assert.isAbove(
				afterValue.itemCount ?? 0,
				initialValue.itemCount ?? 0,
			);
			assert.isAtLeast(afterValue.nearBottomTriggers ?? 0, 2);
		} finally {
			if (browser) await close(browser);
			await stopServer(server);
		}
	});
});
