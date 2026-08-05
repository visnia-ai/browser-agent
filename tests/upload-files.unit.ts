import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "mocha";
import { uploadFiles } from "../src/browser/interaction/upload.js";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { replaceSemanticRefSnapshot } from "../src/browser/semantic-ref-registry.js";

describe("upload files", () => {
	it("sets files directly on file inputs", async () => {
		const workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "upload-files-"),
		);
		try {
			const uploadPath = path.join(workspaceDir, "report.pdf");
			fs.writeFileSync(uploadPath, "pdf", "utf-8");

			const setFileInputCalls: Array<{
				nodeId?: number;
				files: string[];
			}> = [];
			const runtimeCalls: string[] = [];
			const browser = {
				client: {
					on() {},
					removeListener() {},
				},
				DOM: {
					getDocument: async () => ({ root: { nodeId: 1 } }),
					pushNodesByBackendIdsToFrontend: async () => ({
						nodeIds: [2],
					}),
					querySelector: async () => ({ nodeId: 2 }),
					resolveNode: async () => ({
						object: { objectId: "obj-2" },
					}),
					setFileInputFiles: async (input: {
						nodeId?: number;
						files: string[];
					}) => {
						setFileInputCalls.push(input);
					},
				},
				Runtime: {
					callFunctionOn: async (input: {
						functionDeclaration: string;
					}) => {
						runtimeCalls.push(input.functionDeclaration);
						if (
							input.functionDeclaration.includes(
								'type === "file"',
							)
						) {
							return { result: { value: true } };
						}
						return { result: { value: undefined } };
					},
				},
			} as never;
			replaceSemanticRefSnapshot(browser, [
				{
					ref: "r12",
					backendNodeId: 12,
					role: "input",
					capabilities: ["upload"],
				},
			]);

			await uploadFiles({
				browser,
				ref: "r12",
				paths: ["./report.pdf"],
				fileWorkspaceRoot: workspaceDir,
			});

			assert.deepEqual(setFileInputCalls, [
				{
					nodeId: 2,
					files: [fs.realpathSync(uploadPath)],
				},
			]);
			assert.isTrue(
				runtimeCalls.some((call) => call.includes('type === "file"')),
			);
			assert.isTrue(
				runtimeCalls.some((call) =>
					call.includes('dispatchEvent(new Event("change"'),
				),
			);
		} finally {
			fs.rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	it("rejects paths that escape the workspace root", async () => {
		const workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "upload-files-"),
		);
		try {
			try {
				await uploadFiles({
					browser: {} as never,
					ref: "r12",
					paths: ["../secret.txt"],
					fileWorkspaceRoot: workspaceDir,
				});
				assert.fail("Expected uploadFiles to reject escaped paths");
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

	it("rejects hidden workspace paths and escaping symlinks", async () => {
		const workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "upload-files-"),
		);
		const outsideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "upload-files-outside-"),
		);
		try {
			fs.writeFileSync(path.join(workspaceDir, ".secret.txt"), "secret");
			fs.writeFileSync(path.join(outsideDir, "outside.txt"), "outside");
			fs.symlinkSync(
				path.join(outsideDir, "outside.txt"),
				path.join(workspaceDir, "linked.txt"),
			);

			for (const requestedPath of ["./.secret.txt", "./linked.txt"]) {
				let rejected = false;
				try {
					await uploadFiles({
						browser: {} as never,
						ref: "r12",
						paths: [requestedPath],
						fileWorkspaceRoot: workspaceDir,
					});
				} catch {
					rejected = true;
				}
				assert.isTrue(rejected);
			}
		} finally {
			fs.rmSync(workspaceDir, { recursive: true, force: true });
			fs.rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("reports upload_files as unavailable without a workspace root", async () => {
		const result = await executeActions({
			b: {} as never,
			actions: [
				{
					type: "upload_files",
					ref: "r12",
					paths: ["./report.pdf"],
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-upload-action-memory.txt",
		});

		assert.lengthOf(result.interactionErrors, 1);
		assert.include(
			result.interactionErrors[0] ?? "",
			"upload_files is unavailable because this browser session has no file workspace root",
		);
	});
});
