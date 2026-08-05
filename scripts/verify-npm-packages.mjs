import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [wrapperTarball, assetDirectory] = process.argv.slice(2);
if (!wrapperTarball || !assetDirectory) {
	throw new Error(
		"Usage: verify-npm-packages <wrapper.tgz> <release-asset-directory>",
	);
}
const directory = fs.mkdtempSync(
	path.join(os.tmpdir(), "browser-agent-npm-package-"),
);

function run(command, arguments_, options = {}) {
	const result = spawnSync(command, arguments_, {
		cwd: directory,
		encoding: "utf8",
		...options,
	});
	assert.equal(
		result.status,
		0,
		`${command} ${arguments_.join(" ")} failed:\n${result.stderr}`,
	);
	return result;
}

try {
	fs.writeFileSync(
		path.join(directory, "package.json"),
		JSON.stringify({ private: true, type: "module" }),
	);
	run(process.platform === "win32" ? "npm.cmd" : "npm", [
		"install",
		"--ignore-scripts",
		"--no-package-lock",
		"--offline",
		path.resolve(wrapperTarball),
	]);
	const require = createRequire(path.join(directory, "package.json"));
	const packageManifestPath =
		require.resolve("browser-agent-sdk/package.json");
	const packageRoot = path.dirname(packageManifestPath);
	const packageManifest = JSON.parse(
		fs.readFileSync(packageManifestPath, "utf8"),
	);
	assert.deepEqual(packageManifest.bin, {
		"browser-agent": "./scripts/run-cli.mjs",
	});
	assert.equal(
		fs.existsSync(path.join(packageRoot, "bin")),
		false,
		"The npm tarball must not contain a CLI binary",
	);
	const manifest = JSON.parse(
		fs.readFileSync(path.join(packageRoot, "cli-manifest.json"), "utf8"),
	);
	assert.equal(
		manifest.version,
		packageManifest.version,
	);
	const key = `${process.platform}-${process.arch}`;
	const target = manifest.platforms[key];
	assert(target, `Packaged manifest does not support ${key}`);
	const payload = fs.readFileSync(path.join(assetDirectory, target.asset));
	const installer = await import(
		pathToFileURL(path.join(packageRoot, "scripts", "install-cli.mjs")).href
	);
	const executable = await installer.installCli({
		root: packageRoot,
		fetchImplementation: async () => new Response(payload),
	});
	const runtime = await import(
		pathToFileURL(path.join(packageRoot, "dist", "runtime.js")).href
	);
	assert.equal(await runtime.resolveExecutable(), executable);
	const launcher = path.join(
		directory,
		"node_modules",
		".bin",
		process.platform === "win32" ? "browser-agent.cmd" : "browser-agent",
	);
	const selfTest = run(launcher, ["--sdk-self-test-json"]);
	assert.deepEqual(JSON.parse(selfTest.stdout), {
		sharp: true,
		tesseract: true,
		tiktoken: true,
		pdf: true,
		docx: true,
		xlsx: true,
	});
} finally {
	fs.rmSync(directory, { recursive: true, force: true });
}

console.log("npm SDK package verified.");
