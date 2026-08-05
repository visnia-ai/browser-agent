import { CONTEXT_DIR, STEPS_DIR } from "./browser/constants.js";
import fs from "fs";

interface RuntimeOptions {
	saveStepsContext: boolean;
	saveTaskLogs: boolean;
}

const runtimeOptions: RuntimeOptions = {
	saveStepsContext: false,
	saveTaskLogs: false,
};

export function setRuntimeOptions(options: Partial<RuntimeOptions>): void {
	if (options.saveStepsContext !== undefined) {
		runtimeOptions.saveStepsContext = options.saveStepsContext;
	}
	if (options.saveTaskLogs !== undefined) {
		runtimeOptions.saveTaskLogs = options.saveTaskLogs;
	}
}

export function shouldSaveStepsContext(): boolean {
	return runtimeOptions.saveStepsContext;
}

export function shouldSaveTaskLogs(): boolean {
	return runtimeOptions.saveTaskLogs;
}

/** Remove and recreate the steps and context directories. Call once at startup. */
export function resetStepsDir(): void {
	const shouldSave = shouldSaveStepsContext();
	for (const dir of [STEPS_DIR, CONTEXT_DIR]) {
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true });
		}
		if (shouldSave) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}
}
