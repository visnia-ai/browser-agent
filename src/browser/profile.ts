import * as fs from "fs";
import * as path from "path";

export interface SeededBrowserProfilesConfig {
	mode: "seeded";
	seedUserDataDir: string;
	perWorkerUserDataRoot: string;
	reuseExistingWorkerProfiles: boolean;
}

export type BrowserProfilesConfig = SeededBrowserProfilesConfig;

export interface WorkerProfileCleanupFailure {
	directory: string;
	error: string;
}

export interface WorkerProfileCleanupResult {
	removedDirectories: string[];
	failures: WorkerProfileCleanupFailure[];
}

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

function removeWorkerUserDataDirs(input: {
	browserProfiles: BrowserProfilesConfig;
	workerUserDataDirs: ReadonlyMap<number, string>;
}): WorkerProfileCleanupResult {
	const workerRoot = path.resolve(
		input.browserProfiles.perWorkerUserDataRoot,
	);
	const seedDir = path.resolve(input.browserProfiles.seedUserDataDir);
	const result: WorkerProfileCleanupResult = {
		removedDirectories: [],
		failures: [],
	};

	for (const workerProfileDir of new Set(input.workerUserDataDirs.values())) {
		const resolvedWorkerProfileDir = path.resolve(workerProfileDir);
		const relativeToRoot = path.relative(
			workerRoot,
			resolvedWorkerProfileDir,
		);
		const isDirectChild =
			relativeToRoot.length > 0 &&
			relativeToRoot !== ".." &&
			!relativeToRoot.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativeToRoot) &&
			!relativeToRoot.includes(path.sep);
		if (
			!isDirectChild ||
			resolvedWorkerProfileDir === seedDir ||
			!/^(?:worker|port)-\d+$/.test(path.basename(resolvedWorkerProfileDir))
		) {
			result.failures.push({
				directory: resolvedWorkerProfileDir,
				error: `Refusing to remove a browser profile directory that is not an expected direct worker child of ${workerRoot}`,
			});
			continue;
		}
		if (!fs.existsSync(resolvedWorkerProfileDir)) {
			continue;
		}
		try {
			fs.rmSync(resolvedWorkerProfileDir, {
				force: true,
				recursive: true,
			});
			result.removedDirectories.push(resolvedWorkerProfileDir);
		} catch (error) {
			result.failures.push({
				directory: resolvedWorkerProfileDir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return result;
}

export function cleanupWorkerUserDataDirs(input: {
	browserProfiles?: BrowserProfilesConfig;
	workerUserDataDirs: ReadonlyMap<number, string>;
}): WorkerProfileCleanupResult {
	if (
		!input.browserProfiles ||
		input.browserProfiles.reuseExistingWorkerProfiles
	) {
		return { removedDirectories: [], failures: [] };
	}
	return removeWorkerUserDataDirs({
		browserProfiles: input.browserProfiles,
		workerUserDataDirs: input.workerUserDataDirs,
	});
}

export function prepareWorkerUserDataDirs(input: {
	browserProfiles?: BrowserProfilesConfig;
	workers: Array<{ port?: number; workerId: number }>;
}): Map<number, string> {
	const profileDirs = new Map<number, string>();
	const createdProfileDirs = new Map<number, string>();
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

	try {
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
			createdProfileDirs.set(worker.workerId, workerProfileDir);
			copyDirectoryContents(
				browserProfiles.seedUserDataDir,
				workerProfileDir,
			);
		}
	} catch (error) {
		const rollback = removeWorkerUserDataDirs({
			browserProfiles,
			workerUserDataDirs: createdProfileDirs,
		});
		if (rollback.failures.length > 0) {
			throw new AggregateError(
				[
					error,
					...rollback.failures.map(
						(failure) =>
							new Error(`${failure.directory}: ${failure.error}`),
					),
				],
				"Failed to prepare browser worker profiles and roll back partial copies",
			);
		}
		throw error;
	}

	return profileDirs;
}
