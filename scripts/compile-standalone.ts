import path from "node:path";
import fs from "node:fs";

const [entrypoint, outfile, platform] = process.argv.slice(2);
if (!entrypoint || !outfile || !platform) {
	throw new Error(
		"Usage: compile-standalone <entrypoint> <outfile> <platform>",
	);
}
const root = path.resolve(import.meta.dirname, "..");
const canvasPlatform = platform.startsWith("linux-")
	? `${platform}-gnu`
	: platform.startsWith("win32-")
		? `${platform}-msvc`
		: platform;
const canvasEntrypoint = Bun.resolveSync("@napi-rs/canvas", root);
const canvasNativePackage = path.join(
	root,
	"node_modules",
	"@napi-rs",
	`canvas-${canvasPlatform}`,
);
const canvasNative = fs
	.readdirSync(canvasNativePackage)
	.map((name) => path.join(canvasNativePackage, name))
	.find((filename) => filename.endsWith(".node"));
if (!canvasNative) {
	throw new Error(`Unable to locate canvas binding for ${platform}.`);
}
const canvasBase64 = fs.readFileSync(canvasNative).toString("base64");
const embeddedCanvasSidecars = fs
	.readdirSync(canvasNativePackage)
	.map((name) => path.join(canvasNativePackage, name))
	.filter(
		(filename) => filename.endsWith(".dat") || filename.endsWith(".dll"),
	)
	.map((filename) => ({
		name: path.basename(filename),
		base64: fs.readFileSync(filename).toString("base64"),
	}));
const languageBase64 = fs
	.readFileSync(
		path.join(
			root,
			"node_modules",
			"@tesseract.js-data",
			"eng",
			"4.0.0",
			"eng.traineddata.gz",
		),
	)
	.toString("base64");
const tiktokenWasmBase64 = fs
	.readFileSync(
		path.join(root, "node_modules", "tiktoken", "tiktoken_bg.wasm"),
	)
	.toString("base64");
const tesseractWorkerEntrypoint = path.join(
	root,
	"node_modules",
	"tesseract.js",
	"src",
	"worker-script",
	"node",
	"index.js",
);
const wrapper = path.join(path.dirname(outfile), "standalone-entry.ts");
const tesseractWorkerWrapper = path.join(
	path.dirname(outfile),
	"standalone-tesseract-worker.ts",
);
const tesseractWorkerSpecifier = `./${path
	.relative(root, tesseractWorkerWrapper)
	.split(path.sep)
	.join(path.posix.sep)}`;
fs.writeFileSync(
	tesseractWorkerWrapper,
	`await import(${JSON.stringify(tesseractWorkerEntrypoint)});\n`,
);
fs.writeFileSync(
	wrapper,
	`
if (!process.argv.includes("--version-json")) {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const nativeDirectoryPrefix = "browser-agent-canvas-";
	if (process.platform === "win32") {
		for (const name of fs.readdirSync(os.tmpdir())) {
			if (!name.startsWith(nativeDirectoryPrefix)) continue;
			try {
				fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
			} catch {}
		}
	}
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), nativeDirectoryPrefix));
	const addon = path.join(directory, ${JSON.stringify(path.basename(canvasNative))});
	fs.writeFileSync(addon, Buffer.from(${JSON.stringify(canvasBase64)}, "base64"));
	const canvasSidecars = ${JSON.stringify(embeddedCanvasSidecars)};
	for (const sidecar of canvasSidecars) {
		fs.writeFileSync(
			path.join(directory, sidecar.name),
			Buffer.from(sidecar.base64, "base64"),
		);
	}
	process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon;
	const canvas = require(addon);
	const { DOMMatrix, DOMPoint, DOMRect } = require(${JSON.stringify(
		path.join(root, "node_modules", "@napi-rs", "canvas", "geometry.js"),
	)});
	const canvasModule = {
		...canvas,
		DOMMatrix,
		DOMPoint,
		DOMRect,
		Path2D: canvas.Path,
		createCanvas: (width, height) => new canvas.CanvasElement(width, height),
	};
	Object.assign(globalThis, {
		DOMMatrix,
		ImageData: canvas.ImageData,
		Path2D: canvas.Path,
		__browserAgentCanvasModule: canvasModule,
	});
	const { WorkerMessageHandler } = await import(${JSON.stringify(
		path.join(
			root,
			"node_modules",
			"pdfjs-dist",
			"legacy",
			"build",
			"pdf.worker.mjs",
		),
	)});
	globalThis.pdfjsWorker = { WorkerMessageHandler };
	const langPath = path.join(directory, "tesseract");
	fs.mkdirSync(langPath);
	fs.writeFileSync(
		path.join(langPath, "eng.traineddata.gz"),
		Buffer.from(${JSON.stringify(languageBase64)}, "base64"),
	);
	globalThis.__browserAgentTesseractOptions = {
		cachePath: langPath,
		gzip: true,
		workerPath: ${JSON.stringify(tesseractWorkerSpecifier)},
		langPath,
	};
	if (process.platform !== "win32") {
		process.once("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
	}
}
await import(${JSON.stringify(entrypoint)});
`,
);
const addon = Bun.resolveSync(`@img/sharp-${platform}/sharp.node`, root);
const isWindows = platform.startsWith("win32-");
let sharpLibraryDirectory: string;
let sharpLibraries: string[];
if (isWindows) {
	sharpLibraryDirectory = path.dirname(addon);
	sharpLibraries = fs
		.readdirSync(sharpLibraryDirectory)
		.filter((name) => name.endsWith(".dll"))
		.map((name) => path.join(sharpLibraryDirectory, name));
	if (sharpLibraries.length === 0) {
		throw new Error(`Unable to locate Sharp DLLs for ${platform}.`);
	}
} else {
	const vipsModule = Bun.resolveSync(
		`@img/sharp-libvips-${platform}/lib`,
		root,
	);
	sharpLibraryDirectory = path.dirname(vipsModule);
	const vips = fs
		.readdirSync(sharpLibraryDirectory)
		.map((name) => path.join(sharpLibraryDirectory, name))
		.find((filename) => /libvips-cpp/.test(filename));
	if (!vips) throw new Error(`Unable to locate libvips for ${platform}.`);
	sharpLibraries = [vips];
}
const addonBase64 = fs.readFileSync(addon).toString("base64");
const embeddedSharpLibraries = sharpLibraries.map((filename) => ({
	name: path.basename(filename),
	base64: fs.readFileSync(filename).toString("base64"),
}));
const embeddedSharp = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const nativeDirectoryPrefix = "browser-agent-sharp-";
if (process.platform === "win32") {
	for (const name of fs.readdirSync(os.tmpdir())) {
		if (!name.startsWith(nativeDirectoryPrefix)) continue;
		try {
			fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
		} catch {}
	}
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), nativeDirectoryPrefix));
const addonDirectory = path.join(root, "node_modules/@img/sharp-${platform}/lib");
const libraryDirectory = path.join(root, ${JSON.stringify(
	isWindows
		? `node_modules/@img/sharp-${platform}/lib`
		: `node_modules/@img/sharp-libvips-${platform}/lib`,
)});
fs.mkdirSync(addonDirectory, { recursive: true });
fs.mkdirSync(libraryDirectory, { recursive: true });
const addon = path.join(addonDirectory, ${JSON.stringify(path.basename(addon))});
fs.writeFileSync(addon, Buffer.from(${JSON.stringify(addonBase64)}, "base64"));
const libraries = ${JSON.stringify(embeddedSharpLibraries)};
for (const library of libraries) {
	fs.writeFileSync(
		path.join(libraryDirectory, library.name),
		Buffer.from(library.base64, "base64"),
	);
}
if (process.platform !== "win32") {
	process.once("exit", () => fs.rmSync(root, { recursive: true, force: true }));
}
module.exports = require(addon);
`;
const embeddedTiktoken = `
'use strict';
const wasm = require('./tiktoken_bg.cjs');
const bytes = Buffer.from(${JSON.stringify(tiktokenWasmBase64)}, 'base64');
const wasmModule = new WebAssembly.Module(bytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, {
	'./tiktoken_bg.js': wasm,
});
wasm.__wbg_set_wasm(wasmInstance.exports);
module.exports = {
	get_encoding: wasm.get_encoding,
	encoding_for_model: wasm.encoding_for_model,
	get_encoding_name_for_model: wasm.get_encoding_name_for_model,
	Tiktoken: wasm.Tiktoken,
};
`;

const result = await Bun.build({
	entrypoints: [wrapper, canvasEntrypoint, tesseractWorkerWrapper],
	compile: { outfile },
	minify: true,
	plugins: [
		{
			name: "use-embedded-canvas",
			setup(build) {
				build.onLoad(
					{
						filter: /pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.mjs$/,
					},
					async ({ path: filename }) => {
						let source = await Bun.file(filename).text();
						const setupStart = source.indexOf(
							"  let canvas;\n  try {",
						);
						const setupEnd = source.indexOf(
							"  if (!globalThis.DOMMatrix) {",
							setupStart,
						);
						if (setupStart < 0 || setupEnd < 0) {
							throw new Error(
								"Unable to patch pdfjs embedded canvas setup.",
							);
						}
						source = `${source.slice(0, setupStart)}  const canvas = globalThis.__browserAgentCanvasModule;\n${source.slice(setupEnd)}`;
						const factoryRequire =
							'    const require = process.getBuiltinModule("module").createRequire(import.meta.url);\n    const canvas = require("@napi-rs/canvas");';
						if (!source.includes(factoryRequire)) {
							throw new Error(
								"Unable to patch pdfjs canvas factory.",
							);
						}
						source = source.replace(
							factoryRequire,
							"    const canvas = globalThis.__browserAgentCanvasModule;",
						);
						return { contents: source, loader: "js" };
					},
				);
			},
		},
		{
			name: "embed-sharp-addon",
			setup(build) {
				build.onLoad(
					{ filter: /sharp[\\/]lib[\\/]sharp\.js$/ },
					() => ({
						contents: embeddedSharp,
						loader: "js",
					}),
				);
			},
		},
		{
			name: "embed-tiktoken-wasm",
			setup(build) {
				build.onLoad(
					{ filter: /tiktoken[\\/]tiktoken\.cjs$/ },
					() => ({
						contents: embeddedTiktoken,
						loader: "js",
					}),
				);
			},
		},
		{
			name: "embed-tesseract-core",
			setup(build) {
				build.onLoad(
					{
						filter: /tesseract\.js[\\/]src[\\/]worker[\\/]node[\\/]defaultOptions\.js$/,
					},
					() => ({
						contents: `
'use strict';
module.exports = require('../../constants/defaultOptions');
`,
						loader: "js",
					}),
				);
				build.onLoad(
					{
						filter: /tesseract\.js[\\/]src[\\/]worker-script[\\/]node[\\/]getCore\.js$/,
					},
					async ({ path: filename }) => {
						const source = await Bun.file(filename).text();
						if (
							!source.includes(
								"require('tesseract.js-core/tesseract-core-simd-lstm')",
							)
						) {
							throw new Error(
								"Unable to patch the Tesseract SIMD LSTM core module.",
							);
						}
						return {
							contents: `
'use strict';
let TesseractCore = null;
module.exports = async (_, __, res) => {
	if (TesseractCore === null) {
		const statusText = 'loading tesseract core';
		res.progress({ status: statusText, progress: 0 });
		TesseractCore = require('tesseract.js-core/tesseract-core-simd-lstm.wasm.js');
		res.progress({ status: statusText, progress: 1 });
	}
	return TesseractCore;
};
`,
							loader: "js",
						};
					},
				);
				build.onLoad(
					{
						filter: /tesseract\.js-core[\\/]tesseract-core-simd-lstm\.wasm\.js$/,
					},
					async ({ path: filename }) => {
						const source = await Bun.file(filename).text();
						const buildFilenameSetup =
							'"undefined"!=typeof __filename?_scriptName=__filename:ba&&(_scriptName=self.location.href);';
						if (!source.includes(buildFilenameSetup)) {
							throw new Error(
								"Unable to remove the Tesseract core build-time filename.",
							);
						}
						return {
							contents: source.replace(
								buildFilenameSetup,
								"ba&&(_scriptName=self.location.href);",
							),
							loader: "js",
						};
					},
				);
			},
		},
		{
			name: "disable-jsdom-sync-xhr",
			setup(build) {
				build.onLoad(
					{
						filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/,
					},
					async ({ path: filename }) => {
						let source = await Bun.file(filename).text();
						const workerResolution =
							'const syncWorkerFile = require.resolve ? require.resolve("./xhr-sync-worker.js") : null;';
						const synchronousRequest =
							"    if (flag.synchronous) {\n      const flagStr";
						if (
							!source.includes(workerResolution) ||
							!source.includes(synchronousRequest)
						) {
							throw new Error(
								"Unable to patch jsdom synchronous XMLHttpRequest.",
							);
						}
						source = source
							.replace(
								workerResolution,
								"const syncWorkerFile = null;",
							)
							.replace(
								synchronousRequest,
								'    if (flag.synchronous) {\n      throw new Error("Synchronous XMLHttpRequest is not supported in standalone browser-agent builds.");\n      const flagStr',
							);
						return { contents: source, loader: "js" };
					},
				);
			},
		},
	],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
