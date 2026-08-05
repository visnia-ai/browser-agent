import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assert } from "chai";
import yaml from "js-yaml";
import { describe, it } from "mocha";
import { DataExtractionCoordinator } from "../src/agents/executor-utils/data-extraction-coordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("DataExtractionCoordinator", () => {
	it("rollback cancels newer jobs while preserving earlier pending work", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-rollback-"));
		const filePath = path.join(dir, "memory-result.txt");
		fs.writeFileSync(filePath, "", "utf-8");
		const coordinator = new DataExtractionCoordinator();
		const releaseEarlier = deferred();
		const releaseNewer = deferred();
		try {
			coordinator.launch({
				root: "earlier",
				run: async () => {
					await releaseEarlier.promise;
					return {
						items: [
							{
								link: "https://example.com/earlier",
								summary: "earlier result",
							},
						],
					};
				},
			});
			const checkpoint = coordinator.checkpoint();
			coordinator.launch({
				root: "newer",
				run: async () => {
					await releaseNewer.promise;
					return {
						items: [
							{
								link: "https://example.com/newer",
								summary: "newer result",
							},
						],
					};
				},
			});

			coordinator.rollback(checkpoint);
			releaseNewer.resolve();
			releaseEarlier.resolve();
			const barrier = await coordinator.waitForAllAndFlush({ filePath });

			assert.deepEqual(barrier.errors, []);
			assert.deepEqual(yaml.load(fs.readFileSync(filePath, "utf-8")), [
				{
					link: "https://example.com/earlier",
					summary: "earlier result",
				},
			]);
		} finally {
			await coordinator.close();
			releaseEarlier.resolve();
			releaseNewer.resolve();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
