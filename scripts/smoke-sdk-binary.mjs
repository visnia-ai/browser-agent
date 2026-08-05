import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = `${process.platform}-${process.arch}`;
const suffix = process.platform === "win32" ? ".exe" : "";
const executable = process.argv[2]
	? path.resolve(process.argv[2])
	: path.join(root, ".sdk-build", platform, `browser-agent${suffix}`);
const packageVersion = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const executableContents = fs.readFileSync(executable);
const buildRootVariants = new Set([
	root,
	root.split(path.sep).join("/"),
	root.split(path.sep).join("\\"),
]);
for (const buildRoot of buildRootVariants) {
	assert.equal(
		executableContents.includes(Buffer.from(buildRoot)),
		false,
		`The standalone executable must not retain its build root: ${buildRoot}`,
	);
}
const isolatedDirectory = fs.mkdtempSync(
	path.join(os.tmpdir(), "browser-agent-standalone-smoke-"),
);
const environment = {
	HOME: isolatedDirectory,
	PATH: process.platform === "win32" ? "" : "/usr/bin:/bin",
	OPENAI_API_KEY: "smoke-test",
	BROWSER_AGENT_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const commandTimeout = 120_000;
const nativeTempPrefixes = ["browser-agent-canvas-", "browser-agent-sharp-"];
const nativeTempDirectoriesBefore = new Map(
	nativeTempPrefixes.map((prefix) => [
		prefix,
		new Set(
			fs
				.readdirSync(os.tmpdir())
				.filter((name) => name.startsWith(prefix)),
		),
	]),
);

function run(arguments_, input) {
	const result = spawnSync(executable, arguments_, {
		cwd: isolatedDirectory,
		env: environment,
		encoding: "utf8",
		input,
		timeout: commandTimeout,
	});
	assert.equal(
		result.error,
		undefined,
		`Standalone SDK command timed out or failed to start: ${arguments_.join(" ")}`,
	);
	return result;
}

const version = run(["--version-json"]);
assert.equal(version.status, 0);
assert.deepEqual(JSON.parse(version.stdout), {
	version: packageVersion,
	rpcProtocolVersion: 1,
});
const encrypted = run(["encrypt", "standalone-encryption-test"]);
assert.equal(encrypted.status, 0, encrypted.stderr);
assert.match(encrypted.stdout.trim(), /^bauth-v1:/);
assert(!encrypted.stdout.includes("standalone-encryption-test"));
const generatedKey = run(["generate-key"]);
assert.equal(generatedKey.status, 0, generatedKey.stderr);
assert.equal(Buffer.from(generatedKey.stdout.trim(), "base64").length, 32);
const after = fs
	.readdirSync(os.tmpdir())
	.filter((name) => name.startsWith("browser-agent-sharp-"));
assert(
	after.every((name) =>
		nativeTempDirectoriesBefore.get("browser-agent-sharp-").has(name),
	),
);

const selfTest = run(["--sdk-self-test-json"]);
assert.equal(selfTest.status, 0, selfTest.stderr);
assert.deepEqual(JSON.parse(selfTest.stdout), {
	sharp: true,
	tesseract: true,
	tiktoken: true,
	pdf: true,
	docx: true,
	xlsx: true,
});
assert.doesNotMatch(
	selfTest.stderr,
	/Cannot (find|load) .*module|native binding/i,
);

const request = `${JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "browser-agent/run",
	params: {},
})}\n`;
const rpc = run(
	[
		path.join(root, "sdk/sdk-test-fixtures/smoke-preflight-config.json"),
		"--rpc",
	],
	request,
);
const response = JSON.parse(rpc.stdout.trim());
assert.equal(response.error.data.code, "CHROME_NOT_FOUND");

const credentialRequest = `${JSON.stringify({
	jsonrpc: "2.0",
	id: 2,
	method: "browser-agent/run",
	params: {
		tasks: [
			{
				credentials: [
					{
						username: "",
						password: "standalone-secret",
						domain: "https://example.com",
					},
				],
			},
		],
	},
})}\n`;
const credentialRpc = run(
	[
		path.join(root, "sdk/sdk-test-fixtures/smoke-preflight-config.json"),
		"--rpc",
	],
	credentialRequest,
);
const credentialResponse = JSON.parse(credentialRpc.stdout.trim());
assert.equal(credentialResponse.error.data.code, "CONFIG_INVALID");
assert(!credentialRpc.stdout.includes("standalone-secret"));
assert(!credentialRpc.stderr.includes("standalone-secret"));
if (process.platform === "win32") {
	for (const [prefix, existing] of nativeTempDirectoriesBefore) {
		for (const name of fs
			.readdirSync(os.tmpdir())
			.filter((candidate) => candidate.startsWith(prefix))) {
			if (!existing.has(name)) {
				fs.rmSync(path.join(os.tmpdir(), name), {
					recursive: true,
					force: true,
				});
			}
		}
	}
}
fs.rmSync(isolatedDirectory, { recursive: true, force: true });
console.log(`Standalone SDK binary smoke tests passed for ${platform}.`);
