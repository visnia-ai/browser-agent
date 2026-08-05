import { getDomain } from "tldts";

function safeHostname(url: string): string | null {
	const trimmed = url.trim();
	if (!trimmed) {
		return null;
	}

	try {
		return new URL(trimmed).hostname;
	} catch {
		try {
			return new URL(`https://${trimmed}`).hostname;
		} catch {
			return null;
		}
	}
}

export function authDomainsMatch(params: {
	configuredUrl: string;
	currentUrl: string;
}): boolean {
	const configuredHostname = safeHostname(params.configuredUrl);
	const currentHostname = safeHostname(params.currentUrl);
	if (!configuredHostname || !currentHostname) {
		return false;
	}
	const configuredDomain = getDomain(configuredHostname);
	const currentDomain = getDomain(currentHostname);
	if (!configuredDomain || !currentDomain) {
		return configuredHostname === currentHostname;
	}
	return configuredDomain === currentDomain;
}
