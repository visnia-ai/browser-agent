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

const HTML_FILE = "scroll-css-fixture.html";

function readAsset(name: string): string {
	return fs.readFileSync(path.join(process.cwd(), "assets", name), "utf-8");
}

async function startFixtureServer(): Promise<{
	server: Server;
	baseUrl: string;
}> {
	const html = readAsset(HTML_FILE);
	const server = createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		if (requestUrl.pathname === `/${HTML_FILE}`) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(html);
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

describe("scroll css fixture e2e", function () {
	this.timeout(30_000);

	it("marks css overflow container as scroll-enabled and scrollable in simplified dom", async () => {
		const { server, baseUrl } = await startFixtureServer();
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, `${baseUrl}/${HTML_FILE}`);
			const simplified = await getSimplifiedDOM(browser);
			const lines = simplified
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			const scrollEnabledLines = lines.filter((line) =>
				line.includes("scroll-enabled"),
			);
			const scrollableLines = lines.filter((line) =>
				line.includes("scrollable"),
			);
			const bothLines = lines.filter(
				(line) =>
					line.includes("scroll-enabled") &&
					line.includes("scrollable"),
			);

			assert.isAtLeast(
				scrollEnabledLines.length,
				1,
				"simplified DOM should include at least one scroll-enabled line",
			);
			assert.isAtLeast(
				scrollableLines.length,
				1,
				"simplified DOM should include at least one scrollable line",
			);
			assert.isAtLeast(
				bothLines.length,
				1,
				"css overflow container should have both scroll markers",
			);

			const nonScrollReferenceLine = lines.find((line) =>
				line.includes("Non-scroll Reference"),
			);
			assert.isDefined(
				nonScrollReferenceLine,
				"fixture heading should appear in simplified DOM",
			);
			assert.notInclude(
				nonScrollReferenceLine ?? "",
				"scroll-enabled",
				"non-scroll heading line should not be marked scroll-enabled",
			);
			assert.notInclude(
				nonScrollReferenceLine ?? "",
				"scrollable",
				"non-scroll heading line should not be marked scrollable",
			);

			const beforeScroll = await browser.Runtime.evaluate({
				expression: `(() => {
          const el = document.querySelector('[data-testid="css-scroll-container"]');
          if (!(el instanceof HTMLElement)) return null;
          return {
            scrollTop: el.scrollTop,
          };
        })()`,
				returnByValue: true,
			});
			const beforeValue = (beforeScroll.result.value ?? null) as {
				scrollTop?: number;
			} | null;
			assert.isNotNull(beforeValue, "scroll container should exist");
			const projection = await getSemanticProjection(browser);
			const scrollRef =
				/generic ref="([^"]+)"\n\s+text name="Static row 1\b/.exec(
					projection,
				)?.[1];
			assert.isString(
				scrollRef,
				`expected semantic scroll-container ref in ${projection}`,
			);

			const execution = await executeActions({
				b: browser,
				actions: [
					{
						type: "scroll",
						ref: scrollRef ?? "",
						deltaY: 420,
					},
				],
				openTabs: [],
				memoryFile: "/tmp/browser-agent-scroll-css-memory.txt",
			});
			assert.deepEqual(
				execution.interactionErrors,
				[],
				"scroll tool should execute without interaction errors",
			);

			const afterScroll = await browser.Runtime.evaluate({
				expression: `(() => {
          const el = document.querySelector('[data-testid="css-scroll-container"]');
          if (!(el instanceof HTMLElement)) return null;
          return el.scrollTop;
        })()`,
				returnByValue: true,
			});
			const afterValue = Number(afterScroll.result.value ?? 0);
			assert.isAbove(
				afterValue,
				Number(beforeValue?.scrollTop ?? 0),
				"scroll tool should increase container scrollTop on css fixture",
			);
		} finally {
			if (browser) await close(browser);
			await stopServer(server);
		}
	});
});
