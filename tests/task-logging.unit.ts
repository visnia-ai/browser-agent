import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "mocha";
import { resetTaskLogsDir, withTaskLogContext } from "../src/task-logging.js";

describe("task logging", () => {
	it("recreates a run-specific log directory if it disappears", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-logging-"));
		const logsDir = path.join(root, "steps.task-logs");
		try {
			resetTaskLogsDir(true, logsDir);
			fs.rmSync(logsDir, { recursive: true });

			const result = await withTaskLogContext(
				31,
				"Search for an interior designer",
				true,
				async () => "completed",
				logsDir,
			);

			assert.equal(result, "completed");
			const files = fs.readdirSync(logsDir);
			assert.deepEqual(files, [
				"task-031-search-for-an-interior-designer.log",
			]);
			assert.include(
				fs.readFileSync(path.join(logsDir, files[0]), "utf8"),
				"Task 31: Search for an interior designer",
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("continues the task when its log path cannot be created", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-logging-"));
		const invalidLogsDir = path.join(root, "not-a-directory");
		fs.writeFileSync(invalidLogsDir, "occupied");
		try {
			const result = await withTaskLogContext(
				1,
				"Still run the task",
				true,
				async () => "completed",
				invalidLogsDir,
			);
			assert.equal(result, "completed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
