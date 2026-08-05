import { assert } from "chai";
import { describe, it } from "mocha";
import { buildRunTaskScopedFileRoots } from "../src/core/run-task-file-roots.js";

describe("runTask file root scoping", () => {
	it("scopes only the download root per task and attempt", () => {
		assert.deepEqual(
			buildRunTaskScopedFileRoots({
				downloadDir: "/tmp/browser-downloads",
				fileWorkspaceRoot: "/tmp/browser-workspace",
				taskNumber: 12,
				runIndex: 2,
				attemptOrdinal: 3,
			}),
			{
				downloadDir:
					"/tmp/browser-downloads/task-012/run-002-attempt-003",
				downloadRootDir: "/tmp/browser-downloads",
				fileWorkspaceRoot: "/tmp/browser-workspace",
			},
		);
	});

	it("keeps a shared workspace while scoping its downloads subtree", () => {
		assert.deepEqual(
			buildRunTaskScopedFileRoots({
				downloadDir: "/tmp/browser-workspace/downloads",
				fileWorkspaceRoot: "/tmp/browser-workspace",
				taskNumber: 1,
				runIndex: 1,
				attemptOrdinal: 1,
			}),
			{
				downloadDir:
					"/tmp/browser-workspace/downloads/task-001/run-001-attempt-001",
				downloadRootDir: "/tmp/browser-workspace/downloads",
				fileWorkspaceRoot: "/tmp/browser-workspace",
			},
		);
	});

	it("can scope download-only setups without a workspace root", () => {
		assert.deepEqual(
			buildRunTaskScopedFileRoots({
				downloadDir: "/tmp/browser-downloads",
				taskNumber: 5,
				runIndex: 1,
				attemptOrdinal: 2,
			}),
			{
				downloadDir:
					"/tmp/browser-downloads/task-005/run-001-attempt-002",
				downloadRootDir: "/tmp/browser-downloads",
				fileWorkspaceRoot: undefined,
			},
		);
	});
});
