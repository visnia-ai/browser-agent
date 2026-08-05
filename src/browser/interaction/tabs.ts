import CDP from "chrome-remote-interface";
import { enableBrowserClientDomains } from "../client-setup.js";
import { withLocalCdpHost } from "../local-cdp.js";
import type { Browser, Tab } from "../types.js";
import { sleep } from "./utils.js";

export async function listTabs(b: Browser): Promise<Tab[]> {
	const targets = await CDP.List(withLocalCdpHost({ port: b.port }));
	return targets
		.filter((t: any) => t.type === "page")
		.map((t: any) => ({ targetId: t.id, url: t.url, title: t.title }));
}

export async function switchTab(b: Browser, targetId: string): Promise<void> {
	await b.onActivateTarget?.(targetId);
	await b.Target.activateTarget({ targetId });

	// Reconnect CDP client to the new target.
	const newClient = await CDP(
		withLocalCdpHost({ port: b.port, target: targetId }),
	);
	const { Page, Runtime, DOM, DOMSnapshot, Input, Target, Accessibility } =
		await enableBrowserClientDomains(newClient);

	// Replace domains on the browser object.
	b.client = newClient;
	b.Page = Page;
	b.Runtime = Runtime;
	b.DOM = DOM;
	b.DOMSnapshot = DOMSnapshot;
	b.Input = Input;
	b.Target = Target;
	b.Accessibility = Accessibility;
	b.currentTargetId = targetId;
	b.onActivateTarget = b.onActivateTarget;
	await b.Page.bringToFront();
	await sleep(300);
}

export async function newTab(b: Browser, url?: string): Promise<Tab> {
	const { targetId } = await b.Target.createTarget({
		url: url || "about:blank",
	});
	await sleep(500);
	await switchTab(b, targetId);
	return { targetId, url: url || "about:blank", title: "" };
}

export async function closeTab(b: Browser, targetId: string): Promise<void> {
	await b.Target.closeTarget({ targetId });

	// Switch to the first remaining tab.
	const tabs = await listTabs(b);
	if (tabs.length > 0) {
		await switchTab(b, tabs[0].targetId);
	}
}
