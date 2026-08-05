import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "mocha";
import {
	buildWorkerProfileDirectory,
	prepareWorkerUserDataDirs,
} from "../src/browser/profile.js";

describe("browser profile seeding", () => {
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
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-profile-seed-"),
		);
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
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-profile-reuse-"),
		);
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
});
