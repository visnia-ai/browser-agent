import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	access,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

export function platformKey(
	platform = process.platform,
	architecture = process.arch,
) {
	return `${platform}-${architecture}`;
}

async function digestFile(file) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

export async function installCli({
	root = packageRoot,
	platform = process.platform,
	architecture = process.arch,
	baseUrl,
	fetchImplementation = globalThis.fetch,
} = {}) {
	if (typeof fetchImplementation !== "function") {
		throw new Error("Node.js 20 or newer is required to download the CLI.");
	}
	const manifest = JSON.parse(
		await readFile(path.join(root, "cli-manifest.json"), "utf8"),
	);
	const packageManifest = JSON.parse(
		await readFile(path.join(root, "package.json"), "utf8"),
	);
	if (manifest.version !== packageManifest.version) {
		throw new Error(
			`CLI manifest version ${manifest.version} does not match npm package version ${packageManifest.version}.`,
		);
	}
	const key = platformKey(platform, architecture);
	const target = manifest.platforms?.[key];
	if (!target) {
		throw new Error(`The Browser Agent CLI does not support ${key}.`);
	}
	if (!/^[a-f0-9]{64}$/.test(target.sha256)) {
		throw new Error(
			`The Browser Agent CLI manifest has an invalid hash for ${key}.`,
		);
	}
	const suffix = platform === "win32" ? ".exe" : "";
	const directory = path.join(root, "bin");
	const executable = path.join(directory, `browser-agent${suffix}`);
	try {
		if ((await stat(executable)).isFile()) {
			if ((await digestFile(executable)) === target.sha256)
				return executable;
		}
	} catch {}

	const url = baseUrl
		? `${baseUrl.replace(/\/$/, "")}/${target.asset}`
		: target.url;
	if (
		typeof url !== "string" ||
		(!baseUrl && !url.startsWith("https://github.com/"))
	) {
		throw new Error(
			`The Browser Agent CLI manifest has an invalid GitHub Release URL for ${key}.`,
		);
	}
	const temporary = `${executable}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(directory, { recursive: true });
	try {
		const response = await fetchImplementation(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok || !response.body) {
			throw new Error(
				`GitHub Release download failed with HTTP ${response.status}.`,
			);
		}
		const hash = createHash("sha256");
		await pipeline(
			response.body,
			new Transform({
				transform(chunk, _encoding, callback) {
					hash.update(chunk);
					callback(null, chunk);
				},
			}),
			createWriteStream(temporary, { mode: 0o755 }),
		);
		const actual = hash.digest("hex");
		if (actual !== target.sha256) {
			throw new Error(
				`Browser Agent CLI checksum mismatch for ${key}: expected ${target.sha256}, received ${actual}.`,
			);
		}
		if (platform !== "win32") await chmod(temporary, 0o755);
		await rename(temporary, executable);
		return executable;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	try {
		try {
			await access(path.join(packageRoot, "cli-manifest.json"));
		} catch {
			if (
				process.env.INIT_CWD &&
				path.resolve(process.env.INIT_CWD) === packageRoot
			) {
				console.log(
					"Skipping Browser Agent CLI installation in the SDK source checkout.",
				);
				process.exit(0);
			}
			throw new Error(
				"The published package is missing its CLI release manifest.",
			);
		}
		const executable = await installCli();
		console.log(`Installed Browser Agent CLI at ${executable}.`);
	} catch (error) {
		console.error(
			`Unable to install the Browser Agent CLI: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		process.exitCode = 1;
	}
}
