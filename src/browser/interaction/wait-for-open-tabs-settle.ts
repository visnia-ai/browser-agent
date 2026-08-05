import CDP from "chrome-remote-interface";
import { withLocalCdpHost } from "../local-cdp.js";
import type { Browser } from "../types.js";
import { sleep } from "./utils.js";

interface WaitForOpenTabsSettleOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
	networkIdleQuietMs?: number;
}

interface TabLoadingSnapshot {
	readyState: string;
	domContentLoaded: boolean;
	loadEvent: boolean;
	jqueryIdle: boolean;
	hasBusyLoadingSignal: boolean;
	hasPendingImages: boolean;
}

interface TabTracker {
	targetId: string;
	client: CDP.Client;
	inflightRequests: number;
	lastNetworkActivityAtMs: number;
	activeDownloadGuids: Set<string>;
}

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_NETWORK_IDLE_QUIET_MS = 500;

/** CDP.List / connect / evaluate must not stall the whole settle (Electron shares one debug port across many targets). */
const CDP_LIST_TIMEOUT_MS = 5_000;
const CREATE_TAB_TRACKER_TIMEOUT_MS = 8_000;
const IS_TAB_SETTLED_EVAL_TIMEOUT_MS = 500;

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	onTimeout: () => T,
): Promise<T> {
	return Promise.race([promise, sleep(ms).then(() => onTimeout())]);
}

const TAB_LOADING_SNAPSHOT_EXPRESSION = `(() => {
  const navEntry = performance.getEntriesByType("navigation")[0];
  const readyState = document.readyState || "";
  const domContentLoaded = navEntry
    ? navEntry.domContentLoadedEventEnd > 0
    : readyState !== "loading";
  const loadEvent = navEntry
    ? navEntry.loadEventEnd > 0
    : readyState === "complete";
  const jqueryIdle =
    typeof window.jQuery === "undefined" ||
    !window.jQuery ||
    window.jQuery.active === 0;
  const hasBusyLoadingSignal = Boolean(
    document.querySelector(
      '[aria-busy="true"], [data-loading="true"], [data-state="loading"], [data-status="loading"]',
    ),
  );
  const hasPendingImages = Array.from(document.images || []).some(
    (img) => !img.complete,
  );
  return {
    readyState,
    domContentLoaded,
    loadEvent,
    jqueryIdle,
    hasBusyLoadingSignal,
    hasPendingImages,
  };
})()`;

async function createTabTracker(
	port: number,
	targetId: string,
): Promise<TabTracker | null> {
	let client: CDP.Client;
	try {
		client = await CDP(withLocalCdpHost({ port, target: targetId }));
	} catch {
		return null;
	}

	const tracker: TabTracker = {
		targetId,
		client,
		inflightRequests: 0,
		lastNetworkActivityAtMs: Date.now(),
		activeDownloadGuids: new Set<string>(),
	};

	const bumpActivity = (): void => {
		tracker.lastNetworkActivityAtMs = Date.now();
	};
	const incrementInflight = (): void => {
		tracker.inflightRequests += 1;
		bumpActivity();
	};
	const decrementInflight = (): void => {
		tracker.inflightRequests = Math.max(0, tracker.inflightRequests - 1);
		bumpActivity();
	};
	const markDownloadStarted = (guid: string): void => {
		if (!guid) return;
		tracker.activeDownloadGuids.add(guid);
		bumpActivity();
	};
	const markDownloadSettled = (guid: string): void => {
		if (!guid) return;
		tracker.activeDownloadGuids.delete(guid);
		bumpActivity();
	};

	try {
		await Promise.all([
			client.Page.enable(),
			client.Runtime.enable(),
			client.Network.enable(),
		]);
		client.Network.requestWillBeSent(incrementInflight);
		client.Network.loadingFinished(decrementInflight);
		client.Network.loadingFailed(decrementInflight);
		client.Page.downloadWillBegin(({ guid }) => {
			markDownloadStarted(guid);
		});
		client.Page.downloadProgress(({ guid, state }) => {
			if (state === "inProgress") {
				markDownloadStarted(guid);
				return;
			}
			markDownloadSettled(guid);
		});
		return tracker;
	} catch {
		try {
			await client.close();
		} catch {
			// Best-effort cleanup.
		}
		return null;
	}
}

async function closeTabTrackers(trackers: TabTracker[]): Promise<void> {
	await Promise.all(
		trackers.map(async (tracker) => {
			try {
				await tracker.client.close();
			} catch {
				// Best-effort cleanup.
			}
		}),
	);
}

async function readTabLoadingSnapshot(
	tracker: TabTracker,
): Promise<TabLoadingSnapshot | null> {
	try {
		const { result } = await tracker.client.Runtime.evaluate({
			expression: TAB_LOADING_SNAPSHOT_EXPRESSION,
			returnByValue: true,
		});
		const value = result.value as TabLoadingSnapshot | undefined;
		if (!value || typeof value !== "object") return null;
		return value;
	} catch {
		return null;
	}
}

async function isTabSettled(params: {
	tracker: TabTracker;
	networkIdleQuietMs: number;
}): Promise<boolean> {
	const { tracker, networkIdleQuietMs } = params;
	const snapshot = await withTimeout(
		readTabLoadingSnapshot(tracker),
		IS_TAB_SETTLED_EVAL_TIMEOUT_MS,
		() => null,
	);
	if (!snapshot) return true;

	const now = Date.now();
	const networkIdle =
		tracker.inflightRequests === 0 &&
		now - tracker.lastNetworkActivityAtMs >= networkIdleQuietMs;
	const domReady =
		snapshot.readyState === "complete" &&
		snapshot.domContentLoaded &&
		snapshot.loadEvent;
	const heuristicsSettled =
		snapshot.jqueryIdle &&
		!snapshot.hasBusyLoadingSignal &&
		!snapshot.hasPendingImages;
	const downloadsSettled = tracker.activeDownloadGuids.size === 0;

	return domReady && networkIdle && heuristicsSettled && downloadsSettled;
}

export async function waitForAllOpenTabsToSettle(
	b: Browser,
	options: WaitForOpenTabsSettleOptions = {},
): Promise<void> {
	const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const pollIntervalMs = Math.max(
		25,
		options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
	);
	const networkIdleQuietMs = Math.max(
		0,
		options.networkIdleQuietMs ?? DEFAULT_NETWORK_IDLE_QUIET_MS,
	);

	if (timeoutMs === 0) return;

	let targetInfos:
		| Array<{
				id?: string;
				type?: string;
		  }>
		| undefined;
	try {
		targetInfos = await withTimeout<
			NonNullable<typeof targetInfos> | undefined
		>(
			CDP.List(withLocalCdpHost({ port: b.port })),
			CDP_LIST_TIMEOUT_MS,
			() => undefined,
		);
	} catch {
		return;
	}
	if (!targetInfos) {
		return;
	}

	const pageTargetIds = (targetInfos || [])
		.filter(
			(target) => target.type === "page" && typeof target.id === "string",
		)
		.map((target) => target.id as string);

	if (pageTargetIds.length === 0) return;

	const trackers = (
		await Promise.all(
			pageTargetIds.map((targetId) =>
				withTimeout(
					createTabTracker(b.port, targetId),
					CREATE_TAB_TRACKER_TIMEOUT_MS,
					() => null,
				).catch(() => null),
			),
		)
	).filter((tracker): tracker is TabTracker => Boolean(tracker));

	if (trackers.length === 0) return;

	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const settledByTab = await Promise.all(
				trackers.map((tracker) =>
					isTabSettled({ tracker, networkIdleQuietMs }),
				),
			);
			if (settledByTab.every(Boolean)) return;

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			await sleep(Math.min(pollIntervalMs, remainingMs));
		}
	} finally {
		await closeTabTrackers(trackers);
	}
}
