import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import type { Browser } from "../src/browser/types.js";

describe("agent_takeover action execution", () => {
	it("delegates to OS callback and appends result to memory", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "agent-takeover-"));
		const memoryFile = path.join(dir, "memory.txt");
		writeFileSync(memoryFile, "Existing note\n", "utf8");
		try {
			const result = await executeActions({
				b: {} as Browser,
				actions: [
					{
						type: "agent_takeover",
						request: "Extract service ID from ./bill.pdf.",
					},
				],
				openTabs: [
					{
						targetId: "tab-1",
						title: "Provider",
						url: "https://example.com/form",
					},
				],
				memoryFile,
				currentUrl: "https://example.com/form",
				workspaceFiles: ["./bill.pdf", "../outside.pdf"],
				downloadedFiles: [
					"[NEW] ./downloads/bill-copy.pdf",
					"[DOWNLOADING] ./downloads/partial.pdf",
				],
				requestAgentTakeover: async (request) => {
					assert.deepEqual(request.workspaceFiles, ["./bill.pdf"]);
					assert.deepEqual(request.downloadedFiles, [
						"./downloads/bill-copy.pdf",
					]);
					assert.strictEqual(
						request.request,
						"Extract service ID from ./bill.pdf.",
					);
					return {
						status: "completed",
						memoryContent:
							"Source: ./bill.pdf\nService ID: ABC-123",
					};
				},
			});

			assert.strictEqual(result.pendingMemoryRead, true);
			const memory = readFileSync(memoryFile, "utf8");
			assert.include(memory, "Existing note");
			assert.include(memory, "OS-prepared context:");
			assert.include(memory, "Service ID: ABC-123");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
