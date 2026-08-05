import * as path from "path";

function formatTaskLabel(taskNumber: number): string {
	return `task-${String(taskNumber).padStart(3, "0")}`;
}

function formatAttemptLabel(params: {
	runIndex: number;
	attemptOrdinal: number;
}): string {
	return `run-${String(params.runIndex).padStart(3, "0")}-attempt-${String(params.attemptOrdinal).padStart(3, "0")}`;
}

export function buildRunTaskScopedFileRoots(params: {
	downloadDir?: string;
	fileWorkspaceRoot?: string;
	taskNumber: number;
	runIndex: number;
	attemptOrdinal: number;
}): {
	downloadDir?: string;
	downloadRootDir?: string;
	fileWorkspaceRoot?: string;
} {
	const taskLabel = formatTaskLabel(params.taskNumber);
	const attemptLabel = formatAttemptLabel({
		runIndex: params.runIndex,
		attemptOrdinal: params.attemptOrdinal,
	});
	const scopedDownloadDir = params.downloadDir
		? path.join(params.downloadDir, taskLabel, attemptLabel)
		: undefined;

	return {
		downloadDir: scopedDownloadDir,
		downloadRootDir: params.downloadDir,
		fileWorkspaceRoot: params.fileWorkspaceRoot,
	};
}
