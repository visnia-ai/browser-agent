import { assert } from "chai";
import { describe, it } from "mocha";
import { reportExecution } from "../src/utils.js";

describe("reportExecution", () => {
	it("prints token usage and step timings in the recap", () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...values: unknown[]) => {
			output.push(values.map(String).join(" "));
		};

		try {
			reportExecution(
				"done",
				2,
				[
					{
						step: 1,
						input_tokens: 100,
						cached_input_tokens: 20,
						output_tokens: 10,
						total_tokens: 110,
					},
					{
						step: 2,
						input_tokens: 200,
						cached_input_tokens: 30,
						output_tokens: 15,
						total_tokens: 215,
					},
				],
				true,
				undefined,
				[
					{
						stepNumber: 1,
						totalDurationMs: 3456,
						tokenGenerationMs: 1234,
						browserInteractionMs: 1000,
					},
					{
						stepNumber: 2,
						totalDurationMs: 4567,
						tokenGenerationMs: 2345,
						browserInteractionMs: 1500,
					},
				],
			);
		} finally {
			console.log = originalLog;
		}

		const recap = output.slice(output.indexOf("\nRECAP:"));
		assert.strictEqual(recap[0], "\nRECAP:");
		assert.include(recap[2] ?? "", "Reasoning | Output    | Total");
		assert.include(recap[2] ?? "", "LLM Time (s) | Step Time (s)");
		assert.match(recap[4] ?? "", /1\.23\s+\|\s+3\.46$/);
		assert.match(recap[5] ?? "", /2\.35\s+\|\s+4\.57$/);
		assert.match(recap[7] ?? "", /3\.58\s+\|\s+8\.02$/);
	});

	it("prints extraction usage below its parent without changing totals", () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...values: unknown[]) => {
			output.push(values.map(String).join(" "));
		};

		try {
			reportExecution(
				"done",
				2,
				[
					{
						step: 1,
						input_tokens: 100,
						output_tokens: 10,
						total_tokens: 110,
					},
					{
						step: 2,
						input_tokens: 200,
						output_tokens: 20,
						total_tokens: 220,
					},
				],
				true,
				undefined,
				[
					{
						stepNumber: 1,
						totalDurationMs: 3000,
						tokenGenerationMs: 1000,
						browserInteractionMs: 1000,
					},
					{
						stepNumber: 2,
						totalDurationMs: 4000,
						tokenGenerationMs: 2000,
						browserInteractionMs: 1000,
					},
				],
				[
					{
						parentStep: 1,
						extractionIndex: 1,
						usage: {
							input_tokens: 30,
							output_tokens: 5,
							total_tokens: 35,
							generation_time_ms: 1234,
						},
					},
					{
						parentStep: 1,
						extractionIndex: 2,
						usage: {
							input_tokens: 40,
							cached_input_tokens: 10,
							output_tokens: 6,
							total_tokens: 46,
							generation_time_ms: 2345,
						},
					},
				],
			);
		} finally {
			console.log = originalLog;
		}

		const recap = output.slice(output.indexOf("\nRECAP:"));
		const parentIndex = recap.findIndex((line) => /^\s+1\s+\|/.test(line));
		assert.match(recap[parentIndex + 1] ?? "", /↳ extract_data #1/);
		assert.match(
			recap[parentIndex + 1] ?? "",
			/30\s+\|\s+0\s+\|\s+0\s+\|\s+0\s+\|\s+5\s+\|\s+35\s+\|\s+1\.23\s+\|\s+—$/,
		);
		assert.match(recap[parentIndex + 2] ?? "", /↳ extract_data #2/);
		assert.match(recap[parentIndex + 2] ?? "", /2\.35\s+\|\s+—$/);
		assert.match(recap[parentIndex + 3] ?? "", /^\s+2\s+\|/);
		const total = recap.find((line) => line.startsWith("Total")) ?? "";
		assert.match(
			total,
			/300\s+\|\s+0\s+\|\s+0\s+\|\s+0\s+\|\s+30\s+\|\s+330/,
		);
		assert.include(recap, "Extraction subrows are excluded from Total.");
	});

	it("prints stage rows in phase order and includes available usage in totals", () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...values: unknown[]) => {
			output.push(values.map(String).join(" "));
		};

		try {
			reportExecution(
				"done",
				1,
				[
					{
						step: 1,
						input_tokens: 100,
						cached_input_tokens: 20,
						reasoning_tokens: 6,
						non_reasoning_output_tokens: 10,
						output_tokens: 16,
						total_tokens: 116,
					},
				],
				true,
				undefined,
				[
					{
						stepNumber: 1,
						totalDurationMs: 3000,
						tokenGenerationMs: 1000,
						browserInteractionMs: 1000,
					},
				],
				[
					{
						parentStep: 1,
						extractionIndex: 1,
						usage: {
							input_tokens: 500,
							reasoning_tokens: 40,
							non_reasoning_output_tokens: 50,
							output_tokens: 90,
							total_tokens: 590,
							generation_time_ms: 5000,
						},
					},
				],
				[
					{
						phase: "verification",
						stage: "verifySuccess",
						usage: {
							input_tokens: 40,
							cached_input_tokens: 5,
							reasoning_tokens: 2,
							non_reasoning_output_tokens: 4,
							output_tokens: 6,
							total_tokens: 46,
							generation_time_ms: 2000,
						},
					},
					{
						phase: "preprocess",
						stage: "createChecklist",
						usage: {
							input_tokens: 30,
							reasoning_tokens: 3,
							non_reasoning_output_tokens: 3,
							output_tokens: 6,
							total_tokens: 36,
						},
					},
					{
						phase: "preprocess",
						stage: "createChecklist",
						usage: {
							input_tokens: 10,
							reasoning_tokens: undefined,
							non_reasoning_output_tokens: undefined,
							output_tokens: 4,
							total_tokens: 14,
						},
					},
					{
						phase: "verification",
						stage: "verifySuccess",
					},
				],
			);
		} finally {
			console.log = originalLog;
		}

		const recap = output.slice(output.indexOf("\nRECAP:"));
		const firstPreprocess = recap.findIndex((line) =>
			line.includes("preprocess / createChecklist #1"),
		);
		const secondPreprocess = recap.findIndex((line) =>
			line.includes("preprocess / createChecklist #2"),
		);
		const step = recap.findIndex((line) => /^\s+1\s+\|/.test(line));
		const extraction = recap.findIndex((line) =>
			line.includes("↳ extract_data"),
		);
		const firstVerification = recap.findIndex((line) =>
			line.includes("verification / verifySuccess #1"),
		);
		const secondVerification = recap.findIndex((line) =>
			line.includes("verification / verifySuccess #2"),
		);
		assert.isTrue(firstPreprocess < secondPreprocess);
		assert.isTrue(secondPreprocess < step);
		assert.isTrue(step < extraction);
		assert.isTrue(extraction < firstVerification);
		assert.isTrue(firstVerification < secondVerification);
		assert.match(
			recap[firstPreprocess] ?? "",
			/30\s+\|\s+—\s+\|\s+—\s+\|\s+3\s+\|\s+3\s+\|\s+36\s+\|\s+—\s+\|\s+—$/,
		);
		assert.match(
			recap[secondPreprocess] ?? "",
			/10\s+\|\s+—\s+\|\s+—\s+\|\s+—\s+\|\s+—\s+\|\s+14\s+\|\s+—\s+\|\s+—$/,
		);
		assert.match(recap[secondVerification] ?? "", /(\s+—\s+\|){6}\s+—$/);
		const total = recap.find((line) => line.startsWith("Total")) ?? "";
		assert.match(
			total,
			/180\s+\|\s+25\s+\|\s+0\s+\|\s+11\s+\|\s+17\s+\|\s+212\s+\|\s+3\.00\s+\|\s+3\.00$/,
		);
		assert.strictEqual(recap[1]?.length, recap[3]?.length);
	});
});
