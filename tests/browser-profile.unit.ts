import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it } from "mocha";
import {
	buildWorkerProfileDirectory,
	cleanupWorkerUserDataDirs,
	prepareWorkerUserDataDirs,
} from "../src/browser/profile.js";

describe("browser profile seeding", () => {
	const temporaryDirectories: string[] = [];
	const makeTemporaryDirectory = (prefix: string): string => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		temporaryDirectories.push(directory);
		return directory;
	};

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("builds per-worker directories from ports", () => {
		assert.strictEqual(
			buildWorkerProfileDirectory({
				perWorkerUserDataRoot: "/tmp/browser-profiles",
				port: 9222,
				workerId: 1,
			}),
			path.resolve("/tmp/browser-profiles/port-9222"),
		);
		assert.strictEqual(
			buildWorkerProfileDirectory({
				perWorkerUserDataRoot: "/tmp/browser-profiles",
				workerId: 2,
			}),
			path.resolve("/tmp/browser-profiles/worker-2"),
		);
	});

	it("clones a seed profile per worker and skips volatile entries", () => {
		const tempDir = makeTemporaryDirectory("browser-profile-seed-");
		const seedDir = path.join(tempDir, "seed");
		const workerRoot = path.join(tempDir, "workers");
		fs.mkdirSync(path.join(seedDir, "Default"), { recursive: true });
		fs.writeFileSync(
			path.join(seedDir, "Default", "Cookies"),
			"cookie-db",
			"utf-8",
		);
		fs.writeFileSync(path.join(seedDir, "SingletonLock"), "lock", "utf-8");
		fs.mkdirSync(path.join(seedDir, "Crashpad"), { recursive: true });
		fs.writeFileSync(
			path.join(seedDir, "Crashpad", "metrics"),
			"transient",
			"utf-8",
		);

		const profileDirs = prepareWorkerUserDataDirs({
			browserProfiles: {
				mode: "seeded",
				seedUserDataDir: seedDir,
				perWorkerUserDataRoot: workerRoot,
				reuseExistingWorkerProfiles: false,
			},
			workers: [{ port: 9222, workerId: 1 }],
		});

		const workerProfileDir = profileDirs.get(1);
		assert.isString(workerProfileDir);
		assert.isTrue(
			fs.existsSync(path.join(workerProfileDir!, "Default", "Cookies")),
		);
		assert.isFalse(
			fs.existsSync(path.join(workerProfileDir!, "SingletonLock")),
		);
		assert.isFalse(fs.existsSync(path.join(workerProfileDir!, "Crashpad")));
	});

	it("reuses existing worker profiles when configured", () => {
		const tempDir = makeTemporaryDirectory("browser-profile-reuse-");
		const seedDir = path.join(tempDir, "seed");
		const workerRoot = path.join(tempDir, "workers");
		fs.mkdirSync(seedDir, { recursive: true });
		fs.writeFileSync(path.join(seedDir, "Preferences"), "seed", "utf-8");

		const first = prepareWorkerUserDataDirs({
			browserProfiles: {
				mode: "seeded",
				seedUserDataDir: seedDir,
				perWorkerUserDataRoot: workerRoot,
				reuseExistingWorkerProfiles: false,
			},
			workers: [{ port: 9222, workerId: 1 }],
		});
		const workerProfileDir = first.get(1)!;
		fs.writeFileSync(
			path.join(workerProfileDir, "Preferences"),
			"mutated",
			"utf-8",
		);

		prepareWorkerUserDataDirs({
			browserProfiles: {
				mode: "seeded",
				seedUserDataDir: seedDir,
				perWorkerUserDataRoot: workerRoot,
				reuseExistingWorkerProfiles: true,
			},
			workers: [{ port: 9222, workerId: 1 }],
		});

		assert.strictEqual(
			fs.readFileSync(
				path.join(workerProfileDir, "Preferences"),
				"utf-8",
			),
			"mutated",
		);
	});

	it("removes disposable worker copies while preserving the seed, root, and siblings", () => {
		const tempDir = makeTemporaryDirectory("browser-profile-cleanup-");
		const seedDir = path.join(tempDir, "seed");
		const workerRoot = path.join(tempDir, "workers");
		const siblingDir = path.join(workerRoot, "keep-me");
		fs.mkdirSync(seedDir, { recursive: true });
		fs.mkdirSync(siblingDir, { recursive: true });
		fs.writeFileSync(path.join(seedDir, "Preferences"), "seed", "utf-8");
		fs.writeFileSync(path.join(siblingDir, "note.txt"), "keep", "utf-8");
		const browserProfiles = {
			mode: "seeded" as const,
			seedUserDataDir: seedDir,
			perWorkerUserDataRoot: workerRoot,
			reuseExistingWorkerProfiles: false,
		};
		const profileDirs = prepareWorkerUserDataDirs({
			browserProfiles,
			workers: [
				{ workerId: 1 },
				{ port: 9222, workerId: 2 },
			],
		});

		const cleanup = cleanupWorkerUserDataDirs({
			browserProfiles,
			workerUserDataDirs: profileDirs,
		});

		assert.sameMembers(cleanup.removedDirectories, [...profileDirs.values()]);
		assert.deepEqual(cleanup.failures, []);
		assert.isFalse(fs.existsSync(profileDirs.get(1)!));
		assert.isFalse(fs.existsSync(profileDirs.get(2)!));
		assert.isTrue(fs.existsSync(seedDir));
		assert.isTrue(fs.existsSync(workerRoot));
		assert.strictEqual(
			fs.readFileSync(path.join(siblingDir, "note.txt"), "utf-8"),
			"keep",
		);

		assert.deepEqual(
			cleanupWorkerUserDataDirs({
				browserProfiles,
				workerUserDataDirs: profileDirs,
			}),
			{ removedDirectories: [], failures: [] },
		);
	});

	it("preserves worker profiles configured for reuse", () => {
		const tempDir = makeTemporaryDirectory("browser-profile-persist-");
		const seedDir = path.join(tempDir, "seed");
		const workerRoot = path.join(tempDir, "workers");
		fs.mkdirSync(seedDir, { recursive: true });
		fs.writeFileSync(path.join(seedDir, "Preferences"), "seed", "utf-8");
		const browserProfiles = {
			mode: "seeded" as const,
			seedUserDataDir: seedDir,
			perWorkerUserDataRoot: workerRoot,
			reuseExistingWorkerProfiles: true,
		};
		const profileDirs = prepareWorkerUserDataDirs({
			browserProfiles,
			workers: [{ workerId: 1 }],
		});

		const cleanup = cleanupWorkerUserDataDirs({
			browserProfiles,
			workerUserDataDirs: profileDirs,
		});

		assert.deepEqual(cleanup, { removedDirectories: [], failures: [] });
		assert.isTrue(fs.existsSync(profileDirs.get(1)!));
	});

	it("refuses cleanup targets outside the configured worker root", () => {
		const tempDir = makeTemporaryDirectory("browser-profile-safety-");
		const seedDir = path.join(tempDir, "seed");
		const workerRoot = path.join(tempDir, "workers");
		const outsideDir = path.join(tempDir, "worker-99");
		fs.mkdirSync(seedDir, { recursive: true });
		fs.mkdirSync(outsideDir, { recursive: true });
		const cleanup = cleanupWorkerUserDataDirs({
			browserProfiles: {
				mode: "seeded",
				seedUserDataDir: seedDir,
				perWorkerUserDataRoot: workerRoot,
				reuseExistingWorkerProfiles: false,
			},
			workerUserDataDirs: new Map([[99, outsideDir]]),
		});

		assert.lengthOf(cleanup.failures, 1);
		assert.include(cleanup.failures[0]?.error ?? "", "Refusing to remove");
		assert.isTrue(fs.existsSync(outsideDir));
	});
});
