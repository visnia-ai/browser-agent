export const SDK_PLATFORMS = [
	{
		key: "darwin-arm64",
		nodePlatform: "darwin",
		nodeArchitecture: "arm64",
		asset: "browser-agent-macos-arm64",
		archive: "browser-agent-macos-arm64.tar.gz",
	},
	{
		key: "darwin-x64",
		nodePlatform: "darwin",
		nodeArchitecture: "x64",
		asset: "browser-agent-macos-x64",
		archive: "browser-agent-macos-x64.tar.gz",
	},
	{
		key: "linux-arm64",
		nodePlatform: "linux",
		nodeArchitecture: "arm64",
		asset: "browser-agent-linux-arm64",
		archive: "browser-agent-linux-arm64.tar.gz",
	},
	{
		key: "linux-x64",
		nodePlatform: "linux",
		nodeArchitecture: "x64",
		asset: "browser-agent-linux-x64",
		archive: "browser-agent-linux-x64.tar.gz",
	},
	{
		key: "win32-arm64",
		nodePlatform: "win32",
		nodeArchitecture: "arm64",
		asset: "browser-agent-windows-arm64.exe",
		archive: "browser-agent-windows-arm64.zip",
	},
	{
		key: "win32-x64",
		nodePlatform: "win32",
		nodeArchitecture: "x64",
		asset: "browser-agent-windows-x64.exe",
		archive: "browser-agent-windows-x64.zip",
	},
];

export function sdkPlatform(platform, architecture) {
	return SDK_PLATFORMS.find(
		(candidate) =>
			candidate.nodePlatform === platform &&
			candidate.nodeArchitecture === architecture,
	);
}
