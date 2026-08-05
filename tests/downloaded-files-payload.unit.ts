import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "mocha";
import {
	buildDownloadedFilesPayload,
	buildWorkspaceFilesPayload,
} from "../src/agents/executor-utils/step-context.js";

describe("downloaded files payload", () => {
	it("lists completed and in-progress files with relative paths and filters hidden entries", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "download-payload-"),
		);
		try {
			const completedPath = path.join(tmpDir, "report.pdf");
			const inProgressPath = path.join(tmpDir, "report.pdf.crdownload");
			const hiddenFile = path.join(tmpDir, ".DS_Store");
			const hiddenDir = path.join(tmpDir, ".hidden");
			const hiddenNestedFile = path.join(hiddenDir, "secret.pdf");
			const nestedDir = path.join(tmpDir, "docs");
			const nestedPath = path.join(nestedDir, "invoice.pdf");
			fs.writeFileSync(completedPath, "pdf", "utf-8");
			fs.writeFileSync(inProgressPath, "partial", "utf-8");
			fs.writeFileSync(hiddenFile, "meta", "utf-8");
			fs.mkdirSync(hiddenDir);
			fs.writeFileSync(hiddenNestedFile, "hidden", "utf-8");
			fs.mkdirSync(nestedDir);
			fs.writeFileSync(nestedPath, "invoice", "utf-8");

			const state = buildDownloadedFilesPayload({
				downloadDir: tmpDir,
				previousFileSignatures: null,
				previousNewFilePaths: null,
			});

			assert.deepEqual(state.downloadedFiles, [
				"./docs/invoice.pdf",
				"./report.pdf",
				"[DOWNLOADING] ./report.pdf.crdownload",
			]);
			assert.strictEqual(state.fileSignatures.has(completedPath), true);
			assert.strictEqual(state.fileSignatures.has(nestedPath), true);
			assert.strictEqual(state.fileSignatures.has(inProgressPath), false);
			assert.strictEqual(state.fileSignatures.has(hiddenFile), false);
			assert.strictEqual(
				state.fileSignatures.has(hiddenNestedFile),
				false,
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("marks a completed file as [NEW] after it transitions from [DOWNLOADING]", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "download-payload-"),
		);
		try {
			const inProgressPath = path.join(
				tmpDir,
				"statement.pdf.crdownload",
			);
			const completedPath = path.join(tmpDir, "statement.pdf");
			fs.writeFileSync(inProgressPath, "partial", "utf-8");

			const initial = buildDownloadedFilesPayload({
				downloadDir: tmpDir,
				previousFileSignatures: null,
				previousNewFilePaths: null,
			});

			assert.deepEqual(initial.downloadedFiles, [
				"[DOWNLOADING] ./statement.pdf.crdownload",
			]);

			fs.renameSync(inProgressPath, completedPath);
			fs.writeFileSync(completedPath, "final", "utf-8");

			const next = buildDownloadedFilesPayload({
				downloadDir: tmpDir,
				previousFileSignatures: initial.fileSignatures,
				previousNewFilePaths: initial.newFilePaths,
			});

			assert.deepEqual(next.downloadedFiles, ["[NEW] ./statement.pdf"]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("keeps [NEW] markers for the rest of the session after first detection", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "download-payload-"),
		);
		try {
			const existingPath = path.join(tmpDir, "existing.txt");
			const newPath = path.join(tmpDir, "new.txt");
			fs.writeFileSync(existingPath, "v1", "utf-8");

			const initial = buildDownloadedFilesPayload({
				downloadDir: tmpDir,
				previousFileSignatures: null,
				previousNewFilePaths: null,
			});

			fs.writeFileSync(existingPath, "v2", "utf-8");
			fs.writeFileSync(newPath, "new", "utf-8");

			const next = buildDownloadedFilesPayload({
				downloadDir: tmpDir,
				previousFileSignatures: initial.fileSignatures,
				previousNewFilePaths: initial.newFilePaths,
			});

			assert.deepEqual(next.downloadedFiles, [
				"[NEW] ./existing.txt",
				"[NEW] ./new.txt",
			]);

			const later = buildDownloadedFilesPayload({
				downloadDir: tmpDir,
				previousFileSignatures: next.fileSignatures,
				previousNewFilePaths: next.newFilePaths,
			});

			assert.deepEqual(later.downloadedFiles, [
				"[NEW] ./existing.txt",
				"[NEW] ./new.txt",
			]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("renders download paths relative to the workspace root and lists uploadable workspace files", () => {
		const workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "download-workspace-"),
		);
		try {
			const downloadDir = path.join(workspaceDir, "downloads");
			const nestedDir = path.join(workspaceDir, "docs");
			const hiddenDir = path.join(workspaceDir, ".hidden");
			fs.mkdirSync(downloadDir);
			fs.mkdirSync(nestedDir);
			fs.mkdirSync(hiddenDir);

			const downloadedPath = path.join(downloadDir, "statement.pdf");
			const workspacePath = path.join(nestedDir, "notes.txt");
			const hiddenPath = path.join(hiddenDir, "secret.txt");
			fs.writeFileSync(downloadedPath, "pdf", "utf-8");
			fs.writeFileSync(workspacePath, "notes", "utf-8");
			fs.writeFileSync(hiddenPath, "hidden", "utf-8");

			const state = buildDownloadedFilesPayload({
				downloadDir,
				downloadRootDir: downloadDir,
				fileWorkspaceRoot: workspaceDir,
				previousFileSignatures: null,
				previousNewFilePaths: null,
			});
			const workspaceFiles = buildWorkspaceFilesPayload({
				fileWorkspaceRoot: workspaceDir,
				downloadRootDir: downloadDir,
			});

			assert.deepEqual(state.downloadedFiles, [
				"./downloads/statement.pdf",
			]);
			assert.deepEqual(workspaceFiles, ["./docs/notes.txt"]);
		} finally {
			fs.rmSync(workspaceDir, { recursive: true, force: true });
		}
	});

	it("lists only the current scoped download using a stable logical path", () => {
		const workspaceDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "download-workspace-"),
		);
		try {
			const downloadsRoot = path.join(workspaceDir, "downloads");
			const browserDownloadDir = path.join(
				downloadsRoot,
				"briefing-agent",
			);
			fs.mkdirSync(browserDownloadDir, { recursive: true });
			const rootDownloadPath = path.join(
				downloadsRoot,
				"financial_report.pdf",
			);
			const scopedDownloadPath = path.join(
				browserDownloadDir,
				"source.pdf",
			);
			fs.writeFileSync(rootDownloadPath, "final", "utf-8");
			fs.writeFileSync(scopedDownloadPath, "source", "utf-8");

			const state = buildDownloadedFilesPayload({
				downloadDir: browserDownloadDir,
				downloadRootDir: downloadsRoot,
				fileWorkspaceRoot: workspaceDir,
				previousFileSignatures: null,
				previousNewFilePaths: null,
			});

			assert.deepEqual(state.downloadedFiles, ["./downloads/source.pdf"]);
		} finally {
			fs.rmSync(workspaceDir, { recursive: true, force: true });
		}
	});
});
