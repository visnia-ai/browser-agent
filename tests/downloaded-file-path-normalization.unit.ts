import { assert } from "chai";
import { describe, it } from "mocha";
import { canonicalizeStepDownloadedFilePaths } from "../src/agents/executor-utils/downloaded-file-paths.js";

describe("downloaded file path normalization", () => {
	it("rewrites result downloaded_file_path to the canonical temp download path", () => {
		const step = canonicalizeStepDownloadedFilePaths({
			step: {
				thinking: "",
				previousStepStatus: "progressed",
				previousStepOutcome: "",
				currentStateObservation: "",
				nextActionRationale: "",
				actions: [],
				done: true,
				result: `- link: https://example.com
  summary: "Downloaded the file."
  downloaded_file_path: "./Downloads/New Composition #509.mp3"`,
			},
			downloadedFiles: ["[NEW] ./downloads/New Composition #509.mp3"],
		});

		assert.include(step.result ?? "", "./downloads/New Composition #509.mp3");
		assert.notInclude(step.result ?? "", "./Downloads/");
	});

	it("leaves unrelated result strings unchanged", () => {
		const step = canonicalizeStepDownloadedFilePaths({
			step: {
				thinking: "",
				previousStepStatus: "progressed",
				previousStepOutcome: "",
				currentStateObservation: "",
				nextActionRationale: "",
				actions: [],
				done: true,
				result: "Task completed successfully.",
			},
			downloadedFiles: ["./downloads/report.pdf"],
		});

		assert.strictEqual(step.result, "Task completed successfully.");
	});
});
