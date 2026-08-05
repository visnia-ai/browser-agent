export const LOCAL_CDP_HOST = "127.0.0.1";

export function withLocalCdpHost<T extends Record<string, unknown>>(
	options: T,
): T & { host: typeof LOCAL_CDP_HOST } {
	return {
		...options,
		host: LOCAL_CDP_HOST,
	};
}
