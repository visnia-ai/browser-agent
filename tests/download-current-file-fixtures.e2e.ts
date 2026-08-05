import * as fs from "node:fs";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { close, launch } from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

const FIXTURES_DIR = path.join(process.cwd(), "assets", "non-html-fixtures");

interface FixtureSpec {
	fileName: string;
	contentType: string;
}

const FILE_FIXTURES: FixtureSpec[] = [
	{
		fileName: "test_data.json",
		contentType: "application/json; charset=utf-8",
	},
	{ fileName: "csv.csv", contentType: "text/csv; charset=utf-8" },
	{ fileName: "test.pdf", contentType: "application/pdf" },
	{ fileName: "image.jpg", contentType: "image/jpeg" },
	{ fileName: "test.mp3", contentType: "audio/mpeg" },
	{ fileName: "video.mov", contentType: "video/quicktime" },
];

function viewerTagForFixture(fileName: string): string {
	const ext = path.extname(fileName).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".gif") {
		return "img";
	}
	if (ext === ".mp3" || ext === ".wav" || ext === ".ogg") {
		return "audio";
	}
	if (ext === ".mov" || ext === ".mp4" || ext === ".webm") {
		return "video";
	}
	if (ext === ".csv" || ext === ".json") {
		return "iframe";
	}
	return "embed";
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
		const fixture = FILE_FIXTURES.find(
			(entry) => entry.fileName === fileName,
		);

		if (!fixture) {
			if (requestUrl.pathname === "/viewer") {
				const target = requestUrl.searchParams.get("file") || "";
				const fileNameFromQuery = target.replace(/^\/+/, "");
				const fixtureFromQuery = FILE_FIXTURES.find(
					(entry) => entry.fileName === fileNameFromQuery,
				);
				if (!fixtureFromQuery) {
					res.writeHead(404, {
						"content-type": "text/plain; charset=utf-8",
					});
					res.end("unknown fixture");
					return;
				}
				const tag = viewerTagForFixture(fileNameFromQuery);
				const html = `<!doctype html><html><body><h1>Viewer</h1><${tag} src=\"/${fileNameFromQuery}\" controls></${tag}></body></html>`;
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
				});
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

async function fastNavigate(b: Browser, url: string): Promise<void> {
	await b.Page.navigate({ url });
	await Promise.race([
		b.Page.loadEventFired(),
		new Promise<void>((resolve) => setTimeout(resolve, 1200)),
	]);
}

describe("download_current_file fixtures e2e", function () {
	this.timeout(60_000);

	it("downloads each provided non-html fixture through the action executor", async () => {
		const { server, baseUrl } = await startFixtureServer();
		const downloadsDir = path.join(
			process.cwd(),
			"tmp",
			"downloads",
			`download-current-file-${Date.now()}`,
		);
		fs.mkdirSync(downloadsDir, { recursive: true });
		let browser: Browser | null = null;

		try {
			const userDataDir = path.join(
				process.cwd(),
				"tmp",
				"chrome-user-data",
				`download-current-file-${Date.now()}`,
			);
			browser = await launch(
				undefined,
				true,
				undefined,
				downloadsDir,
				userDataDir,
			);

			for (const fixture of FILE_FIXTURES) {
				await fastNavigate(
					browser,
					`${baseUrl}/viewer?file=${encodeURIComponent(fixture.fileName)}`,
				);

				const before = new Set(fs.readdirSync(downloadsDir));
				const result = await executeActions({
					b: browser,
					actions: [{ type: "download_current_file" }],
					openTabs: [],
					memoryFile: path.join(downloadsDir, "memory.txt"),
				});

				assert.deepEqual(
					result.interactionErrors,
					[],
					`download_current_file should succeed for ${fixture.fileName}`,
				);
				const after = fs.readdirSync(downloadsDir);
				const newlyAdded = after.filter((entry) => !before.has(entry));
				assert.isAtLeast(
					newlyAdded.length,
					1,
					`Expected at least one new downloaded file for ${fixture.fileName}`,
				);
				const expectedExt = path
					.extname(fixture.fileName)
					.toLowerCase();
				const hasExpectedExt = newlyAdded.some(
					(entry) =>
						path.extname(entry).toLowerCase() === expectedExt,
				);
				assert.isTrue(
					hasExpectedExt,
					`Expected a downloaded file with extension ${expectedExt} for ${fixture.fileName}, got: ${newlyAdded.join(", ")}`,
				);
			}
		} finally {
			if (browser) await close(browser);
			await stopServer(server);
		}
	});
});
