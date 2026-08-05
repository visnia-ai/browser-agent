import { assert } from "chai";
import { describe, it } from "mocha";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureDownloadBehavior } from "../src/browser/browser.js";

describe("configureDownloadBehavior", () => {
	it("falls back to Page.setDownloadBehavior for attached targets", async () => {
		const downloadDir = mkdtempSync(
			path.join(tmpdir(), "browser-agent-downloads-"),
		);
		const calls: Array<{
			method: string;
			params: Record<string, unknown>;
		}> = [];
		const client = {
			send: async (method: string, params: Record<string, unknown>) => {
				calls.push({ method, params });
				if (method === "Browser.setDownloadBehavior") {
					throw new Error("Browser domain unsupported");
				}
				return {};
			},
		};

		try {
			const resolvedDir = await configureDownloadBehavior(
				client,
				downloadDir,
			);

			assert.strictEqual(resolvedDir, downloadDir);
			assert.deepEqual(
				calls.map((call) => call.method),
				["Browser.setDownloadBehavior", "Page.setDownloadBehavior"],
			);
			assert.strictEqual(calls[1]?.params.downloadPath, downloadDir);
		} finally {
			rmSync(downloadDir, { recursive: true, force: true });
		}
	});
});
