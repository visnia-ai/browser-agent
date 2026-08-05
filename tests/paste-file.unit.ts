import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "mocha";
import { pasteFile } from "../src/browser/interaction/paste-file.js";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { replaceSemanticRefSnapshot } from "../src/browser/semantic-ref-registry.js";

describe("paste_file", () => {
	it("sets exact file text on an editable element", async () => {
		const workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "paste-file-"),
		);
		try {
			fs.writeFileSync(
				path.join(workspaceDir, "extracted.txt"),
				"alpha\nbeta",
				"utf-8",
			);

			const runtimeCalls: Array<{
				functionDeclaration: string;
				arguments?: Array<{ value?: unknown }>;
			}> = [];
			const scrolledNodeIds: number[] = [];
			const browser = {
				DOM: {
					getDocument: async () => ({ root: { nodeId: 1 } }),
					pushNodesByBackendIdsToFrontend: async () => ({
						nodeIds: [2],
					}),
					resolveNode: async () => ({
						object: { objectId: "obj-2" },
					}),
					scrollIntoViewIfNeeded: async (input: {
						nodeId: number;
					}) => {
						scrolledNodeIds.push(input.nodeId);
					},
				},
				Runtime: {
					callFunctionOn: async (input: {
						functionDeclaration: string;
						arguments?: Array<{ value?: unknown }>;
					}) => {
						runtimeCalls.push(input);
						return { result: { value: "" } };
					},
				},
			} as never;
			replaceSemanticRefSnapshot(browser, [
				{
					ref: "r12",
					backendNodeId: 12,
					role: "textbox",
					capabilities: ["type"],
				},
			]);

			await pasteFile({
				browser,
				ref: "r12",
				path: "./extracted.txt",
				fileWorkspaceRoot: workspaceDir,
			});

			assert.deepEqual(scrolledNodeIds, [2]);
			const pasteCall = runtimeCalls.find((call) =>
				call.functionDeclaration.includes("insertFromPaste"),
			);
			assert.isDefined(pasteCall);
			assert.deepEqual(pasteCall?.arguments, [{ value: "alpha\nbeta" }]);
		} finally {
			fs.rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	it("rejects paths that escape the workspace root", async () => {
		const workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "paste-file-"),
		);
		try {
			try {
				await pasteFile({
					browser: {} as never,
					ref: "r12",
					path: "../secret.txt",
					fileWorkspaceRoot: workspaceDir,
				});
				assert.fail("Expected pasteFile to reject escaped paths");
			} catch (error) {
				assert.include(
					error instanceof Error ? error.message : String(error),
					"workspace-relative",
				);
			}
		} finally {
			fs.rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	it("rejects hidden workspace paths", async () => {
		const workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "paste-file-"),
		);
		try {
			fs.writeFileSync(path.join(workspaceDir, ".secret.txt"), "secret");
			let observedError = "";
			try {
				await pasteFile({
					browser: {} as never,
					ref: "r12",
					path: "./.secret.txt",
					fileWorkspaceRoot: workspaceDir,
				});
			} catch (error) {
				observedError =
					error instanceof Error ? error.message : String(error);
			}
			assert.include(observedError, "hidden path segments");
		} finally {
			fs.rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	it("uses workspaceFiles only as informational context", async () => {
		const result = await executeActions({
			b: {} as never,
			actions: [
				{
					type: "paste_file",
					ref: "r12",
					path: "./missing.txt",
				},
			],
			openTabs: [],
			memoryFile: path.join(os.tmpdir(), "memory.txt"),
			fileWorkspaceRoot: os.tmpdir(),
			workspaceFiles: ["./other.txt"],
		});

		assert.deepEqual(result.interactionErrors, [
			'paste_file(ref=r12, path="./missing.txt"): paste_file file path is unavailable: ./missing.txt',
		]);
	});
});
