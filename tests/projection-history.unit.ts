import { assert } from "chai";
import { describe, it } from "mocha";
import {
	buildProjectionUnifiedDiff,
	resolveProjectionHistoryContext,
} from "../src/core/projection-history.js";

describe("projection history diff helper", () => {
	it("builds a focused diff for a small edit", () => {
		const diff = buildProjectionUnifiedDiff(
			['main ref="r1"', '  button ref="r2" name="Old"'].join("\n"),
			['main ref="r1"', '  button ref="r2" name="New"'].join("\n"),
		);

		assert.isString(diff);
		assert.include(diff ?? "", "--- previous-projection");
		assert.include(diff ?? "", '-  button ref="r2" name="Old"');
		assert.include(diff ?? "", '+  button ref="r2" name="New"');
	});

	it("captures insertions", () => {
		const diff = buildProjectionUnifiedDiff(
			'main ref="r1"',
			['main ref="r1"', '  link ref="r2" name="Next"'].join("\n"),
		);

		assert.include(diff ?? "", '+  link ref="r2" name="Next"');
	});

	it("captures deletions", () => {
		const diff = buildProjectionUnifiedDiff(
			['main ref="r1"', '  text name="Remove me"'].join("\n"),
			'main ref="r1"',
		);

		assert.include(diff ?? "", '-  text name="Remove me"');
	});

	it("returns null without a usable base or change", () => {
		assert.strictEqual(buildProjectionUnifiedDiff("", "main"), null);
		assert.strictEqual(buildProjectionUnifiedDiff("main", "main"), null);
	});

	it("uses an empty diff for identical projections", () => {
		assert.deepEqual(
			resolveProjectionHistoryContext({
				previousProjection: "main",
				currentProjection: "main",
			}),
			{ mode: "diff", projection: "", diffLength: 0 },
		);
	});

	it("uses a diff at the exact threshold and resets above it", () => {
		const previousProjection = [
			'main ref="r1"',
			...Array.from(
				{ length: 80 },
				(_, index) => `  text name="${index}"`,
			),
			'  button ref="r2" name="Old"',
		].join("\n");
		const currentProjection = previousProjection.replace(
			'button ref="r2" name="Old"',
			'button ref="r2" name="New"',
		);
		const diff = buildProjectionUnifiedDiff(
			previousProjection,
			currentProjection,
		);
		assert.isString(diff);
		const exactRatio = (diff?.length ?? 0) / currentProjection.length;

		assert.strictEqual(
			resolveProjectionHistoryContext({
				previousProjection,
				currentProjection,
				maxDiffToFullRatio: exactRatio,
			}).mode,
			"diff",
		);
		assert.strictEqual(
			resolveProjectionHistoryContext({
				previousProjection,
				currentProjection,
				maxDiffToFullRatio: exactRatio / 2,
			}).mode,
			"full",
		);
	});

	it("falls back safely for large replacement diffs", () => {
		const previousProjection = Array.from(
			{ length: 1_100 },
			(_, index) => `old-${index}`,
		).join("\n");
		const currentProjection = Array.from(
			{ length: 1_100 },
			(_, index) => `new-${index}`,
		).join("\n");

		const result = resolveProjectionHistoryContext({
			previousProjection,
			currentProjection,
		});
		assert.strictEqual(result.mode, "full");
		assert.strictEqual(result.projection, currentProjection);
	});
});
