import * as fs from "node:fs";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { assert } from "chai";
import { describe, it } from "mocha";
import { close, getSimplifiedDOM, launch } from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

const FIXTURES_DIR = path.join(process.cwd(), "assets", "non-html-fixtures");
const DEBUG_OUTPUT_DIR = path.join(
	process.cwd(),
	"tmp",
	"non-html-simplified-dom",
);

interface NonHtmlCase {
	name: string;
	fileName: string;
	contentType: string;
	expectedDownloadable: "true" | "false" | "unknown";
	expectedDetailField: "preview" | "metadata";
	nonFallbackHints: string[];
}

const NON_HTML_CASES: NonHtmlCase[] = [
	{
		name: "json",
		fileName: "test_data.json",
		contentType: "application/json; charset=utf-8",
		expectedDownloadable: "false",
		expectedDetailField: "preview",
		nonFallbackHints: ["testdata", "domain_url"],
	},
	{
		name: "csv",
		fileName: "csv.csv",
		contentType: "text/csv; charset=utf-8",
		expectedDownloadable: "false",
		expectedDetailField: "preview",
		nonFallbackHints: ["data1", "2020"],
	},
	{
		name: "pdf",
		fileName: "test.pdf",
		contentType: "application/pdf",
		expectedDownloadable: "true",
		expectedDetailField: "metadata",
		nonFallbackHints: ["pdf", "embed", "object"],
	},
	{
		name: "image",
		fileName: "image.jpg",
		contentType: "image/jpeg",
		expectedDownloadable: "true",
		expectedDetailField: "metadata",
		nonFallbackHints: ["img", "image", "jpg"],
	},
	{
		name: "audio",
		fileName: "test.mp3",
		contentType: "audio/mpeg",
		expectedDownloadable: "true",
		expectedDetailField: "metadata",
		nonFallbackHints: ["source", "audio/mpeg", "type="],
	},
	{
		name: "video",
		fileName: "video.mov",
		contentType: "video/quicktime",
		expectedDownloadable: "true",
		expectedDetailField: "metadata",
		nonFallbackHints: ["source", "type=", "audio/mpeg"],
	},
];

function includesAny(text: string, needles: string[]): boolean {
	const haystack = text.toLowerCase();
	return needles.some((needle) => haystack.includes(needle.toLowerCase()));
}

async function fastNavigate(b: Browser, url: string): Promise<void> {
	await b.Page.navigate({ url });
	await Promise.race([
		b.Page.loadEventFired(),
		new Promise<void>((resolve) => setTimeout(resolve, 1200)),
	]);
}

function readFixture(fileName: string): Buffer {
	return fs.readFileSync(path.join(FIXTURES_DIR, fileName));
}

async function startFixtureServer(): Promise<{
	server: Server;
	baseUrl: string;
}> {
	const server = createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		const fileName = requestUrl.pathname.replace(/^\/+/, "");
		const fixture = NON_HTML_CASES.find(
			(entry) => entry.fileName === fileName,
		);

		if (!fixture) {
			if (requestUrl.pathname === "/favicon.ico") {
				res.writeHead(204);
				res.end();
				return;
			}
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("not found");
			return;
		}

		const body = readFixture(fixture.fileName);
		res.writeHead(200, {
			"content-type": fixture.contentType,
			"content-length": String(body.byteLength),
			"cache-control": "no-store",
		});
		res.end(body);
	});
	server.on("error", (error) => {
		console.error("[non-html-fixtures] fixture server error:", error);
	});
	server.on("close", () => {
		console.warn("[non-html-fixtures] fixture server closed");
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

describe("simplify-dom non-html fixtures e2e", function () {
	this.timeout(30_000);

	it("captures non-empty fallback snapshots for non-html files", async () => {
		fs.mkdirSync(DEBUG_OUTPUT_DIR, { recursive: true });
		const { server, baseUrl } = await startFixtureServer();
		let browser: Browser | null = null;
		const failures: string[] = [];

		try {
			const chromeUserDataDir = path.join(
				process.cwd(),
				"tmp",
				"chrome-user-data",
				`non-html-fixtures-${Date.now()}`,
			);
			browser = await launch(
				undefined,
				true,
				undefined,
				undefined,
				chromeUserDataDir,
			);

			for (const fixture of NON_HTML_CASES) {
				const url = `${baseUrl}/${fixture.fileName}`;
				await fastNavigate(browser, url);

				const simplified = await getSimplifiedDOM(browser);
				const outputFile = path.join(
					DEBUG_OUTPUT_DIR,
					`${fixture.name}.simplified.yaml`,
				);
				fs.writeFileSync(outputFile, simplified, "utf-8");

				if (simplified.trim().length === 0) {
					failures.push(
						[
							`Expected non-empty simplified DOM for ${fixture.name}.`,
							`URL: ${url}`,
							`Snapshot: ${outputFile}`,
						].join(" "),
					);
					continue;
				}

				const isFallback = simplified.includes(
					`file-view kind="non-html-fallback"`,
				);
				if (isFallback) {
					if (
						!simplified.includes(
							`downloadable="${fixture.expectedDownloadable}"`,
						)
					) {
						failures.push(
							[
								`Expected downloadable="${fixture.expectedDownloadable}" for ${fixture.name}.`,
								`URL: ${url}`,
								`Snapshot: ${outputFile}`,
							].join(" "),
						);
					}
					if (
						!simplified.includes(
							`${fixture.expectedDetailField}: "`,
						)
					) {
						failures.push(
							[
								`Expected ${fixture.expectedDetailField} field for ${fixture.name}.`,
								`URL: ${url}`,
								`Snapshot: ${outputFile}`,
							].join(" "),
						);
					}
					continue;
				}

				if (!includesAny(simplified, fixture.nonFallbackHints)) {
					failures.push(
						[
							`Expected non-fallback simplified DOM for ${fixture.name} to include one hint from [${fixture.nonFallbackHints.join(", ")}].`,
							`URL: ${url}`,
							`Snapshot: ${outputFile}`,
						].join(" "),
					);
				}
			}

			assert.deepEqual(failures, [], failures.join("\n"));
		} finally {
			if (browser) await close(browser);
			await stopServer(server);
		}
	});
});
