import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installCli, platformKey } from "../scripts/install-cli.mjs";

function fixture(root: string, sha256: string) {
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ name: "@visnia/browser-agent-sdk", version: "1.2.3" }),
	);
	fs.writeFileSync(
		path.join(root, "cli-manifest.json"),
		JSON.stringify({
			version: "1.2.3",
			repository: "visnia-ai/browser-agent",
			platforms: {
				"linux-x64": {
					asset: "browser-agent-linux-x64",
					url: "https://github.com/visnia-ai/browser-agent/releases/download/browser-agent-cli-v1.2.3/browser-agent-linux-x64",
					sha256,
				},
			},
		}),
	);
}

test("maps platform keys", () => {
	assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
});

test("downloads, verifies, installs, and reuses the CLI", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-cli-install-"));
	const payload = Buffer.from("#!/bin/sh\nexit 0\n");
	const digest = createHash("sha256").update(payload).digest("hex");
	fixture(root, digest);
	let requests = 0;
	const server = http.createServer((request, response) => {
		requests += 1;
		if (request.url === "/release/browser-agent-linux-x64") {
			response.writeHead(302, { location: "/asset" });
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "application/octet-stream" });
		response.end(payload);
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	try {
		const address = server.address();
		assert(address && typeof address === "object");
		const baseUrl = `http://127.0.0.1:${address.port}/release`;
		const executable = await installCli({
			root,
			platform: "linux",
			architecture: "x64",
			baseUrl,
		});
		assert.deepEqual(fs.readFileSync(executable), payload);
		assert.equal(fs.statSync(executable).mode & 0o111, 0o111);
		assert.equal(requests, 2);
		assert.equal(
			await installCli({
				root,
				platform: "linux",
				architecture: "x64",
				baseUrl,
			}),
			executable,
		);
		assert.equal(requests, 2);
	} finally {
		server.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("rejects unsupported platforms and checksum mismatches", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-cli-reject-"));
	fixture(root, "0".repeat(64));
	try {
		await assert.rejects(
			installCli({
				root,
				platform: "aix",
				architecture: "ppc64",
			}),
			/does not support aix-ppc64/,
		);
		await assert.rejects(
			installCli({
				root,
				platform: "linux",
				architecture: "x64",
				fetchImplementation: async () =>
					new Response("wrong", { status: 200 }),
			}),
			/checksum mismatch/,
		);
		await assert.rejects(
			installCli({
				root,
				platform: "linux",
				architecture: "x64",
				fetchImplementation: async () =>
					new Response("unavailable", { status: 503 }),
			}),
			/HTTP 503/,
		);
		await assert.rejects(
			installCli({
				root,
				platform: "linux",
				architecture: "x64",
				fetchImplementation: async () => {
					throw new Error("network unavailable");
				},
			}),
			/network unavailable/,
		);
		assert.equal(
			fs.existsSync(path.join(root, "bin", "browser-agent")),
			false,
		);
		assert.deepEqual(fs.readdirSync(path.join(root, "bin")), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("rejects a CLI manifest for another npm package version", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-cli-version-"));
	fixture(root, "0".repeat(64));
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ name: "@visnia/browser-agent-sdk", version: "9.9.9" }),
	);
	try {
		await assert.rejects(
			installCli({
				root,
				platform: "linux",
				architecture: "x64",
			}),
			/manifest version 1.2.3.*package version 9.9.9/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
