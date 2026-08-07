import assert from "node:assert/strict";
import { describe, it } from "mocha";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildChromeLaunchFlags,
	configurePdfDownloadPreference,
	resolveChromeExecutablePath,
} from "../src/browser/browser.js";

describe("buildChromeLaunchFlags", () => {
	it("adds --no-sandbox when running as root", () => {
		const originalGetuid = process.getuid;
		Object.defineProperty(process, "getuid", {
			value: () => 0,
			configurable: true,
		});

		try {
			const flags = buildChromeLaunchFlags({
				headless: true,
			});
			assert.equal(flags.includes("--no-sandbox"), true);
		} finally {
			Object.defineProperty(process, "getuid", {
				value: originalGetuid,
				configurable: true,
			});
		}
	});

	it("preserves keychain-backed profile access for explicit user data dirs", () => {
		const flags = buildChromeLaunchFlags({
			headless: false,
			userDataDirOverride: "/tmp/seeded-profile",
		});

		assert.equal(flags.includes("--use-mock-keychain"), false);
		assert.equal(flags.includes("--password-store=basic"), false);
	});

	it("keeps the default keychain bypass flags for ephemeral profiles", () => {
		const flags = buildChromeLaunchFlags({
			headless: false,
		});

		assert.equal(flags.includes("--use-mock-keychain"), true);
		assert.equal(flags.includes("--password-store=basic"), true);
	});
});

describe("configurePdfDownloadPreference", () => {
	it("preserves profile preferences and makes PDFs download externally", () => {
		const userDataDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "chrome-pdf-preference-"),
		);
		const profileDir = path.join(userDataDir, "Default");
		const preferencesPath = path.join(profileDir, "Preferences");
		fs.mkdirSync(profileDir, { recursive: true });
		fs.writeFileSync(
			preferencesPath,
			JSON.stringify({ homepage: "https://example.com" }),
		);

		try {
			configurePdfDownloadPreference(userDataDir);
			const preferences = JSON.parse(
				fs.readFileSync(preferencesPath, "utf8"),
			);
			assert.equal(preferences.homepage, "https://example.com");
			assert.equal(
				preferences.plugins.always_open_pdf_externally,
				true,
			);
		} finally {
			fs.rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});

describe("resolveChromeExecutablePath", () => {
	it("accepts an explicit executable file", () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "chrome-path-"),
		);
		const executable = path.join(directory, "chrome");
		fs.writeFileSync(executable, "");
		try {
			assert.strictEqual(
				resolveChromeExecutablePath(executable),
				executable,
			);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects a missing explicit executable", () => {
		assert.throws(
			() => resolveChromeExecutablePath("/missing/chrome"),
			/Configured Chrome executable was not found/,
		);
	});
});
