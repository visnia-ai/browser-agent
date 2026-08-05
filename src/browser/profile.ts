import * as fs from "fs";
import * as path from "path";

export interface SeededBrowserProfilesConfig {
	mode: "seeded";
	seedUserDataDir: string;
	perWorkerUserDataRoot: string;
	reuseExistingWorkerProfiles: boolean;
}

export type BrowserProfilesConfig = SeededBrowserProfilesConfig;

const VOLATILE_PROFILE_ENTRY_NAMES = new Set([
	"SingletonCookie",
	"SingletonLock",
	"SingletonSocket",
	"DevToolsActivePort",
]);

const VOLATILE_PROFILE_DIR_NAMES = new Set(["Crashpad", "BrowserMetrics"]);

function shouldCopyProfileEntry(sourcePath: string): boolean {
	const name = path.basename(sourcePath);
	if (VOLATILE_PROFILE_ENTRY_NAMES.has(name)) {
		return false;
	}
	if (VOLATILE_PROFILE_DIR_NAMES.has(name)) {
		return false;
	}
	return true;
}

function copyDirectoryContents(
	sourceDir: string,
	destinationDir: string,
): void {
	for (const entry of fs.readdirSync(sourceDir)) {
		const sourcePath = path.join(sourceDir, entry);
		if (!shouldCopyProfileEntry(sourcePath)) {
			continue;
		}
		const destinationPath = path.join(destinationDir, entry);
		fs.cpSync(sourcePath, destinationPath, {
			force: true,
			recursive: true,
		});
	}
}

export function buildWorkerProfileDirectory(input: {
	perWorkerUserDataRoot: string;
	port?: number;
	workerId: number;
}): string {
	const workerSegment =
		typeof input.port === "number"
			? `port-${input.port}`
			: `worker-${input.workerId}`;
	return path.resolve(input.perWorkerUserDataRoot, workerSegment);
}

export function prepareWorkerUserDataDirs(input: {
	browserProfiles?: BrowserProfilesConfig;
	workers: Array<{ port?: number; workerId: number }>;
}): Map<number, string> {
	const profileDirs = new Map<number, string>();
	if (!input.browserProfiles || input.workers.length === 0) {
		return profileDirs;
	}

	const { browserProfiles } = input;
	if (!fs.existsSync(browserProfiles.seedUserDataDir)) {
		throw new Error(
			`Seed browser profile directory not found: ${browserProfiles.seedUserDataDir}`,
		);
	}
	if (!fs.statSync(browserProfiles.seedUserDataDir).isDirectory()) {
		throw new Error(
			`Seed browser profile path is not a directory: ${browserProfiles.seedUserDataDir}`,
		);
	}

	fs.mkdirSync(browserProfiles.perWorkerUserDataRoot, { recursive: true });

	for (const worker of input.workers) {
		const workerProfileDir = buildWorkerProfileDirectory({
			perWorkerUserDataRoot: browserProfiles.perWorkerUserDataRoot,
			port: worker.port,
			workerId: worker.workerId,
		});
		profileDirs.set(worker.workerId, workerProfileDir);

		if (
			browserProfiles.reuseExistingWorkerProfiles &&
			fs.existsSync(workerProfileDir)
		) {
			continue;
		}

		fs.rmSync(workerProfileDir, { force: true, recursive: true });
		fs.mkdirSync(workerProfileDir, { recursive: true });
		copyDirectoryContents(
			browserProfiles.seedUserDataDir,
			workerProfileDir,
		);
	}

	return profileDirs;
}
