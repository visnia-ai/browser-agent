import type CDP from "chrome-remote-interface";

export interface BrowserClientDomains {
	Page: CDP.Client["Page"];
	Runtime: CDP.Client["Runtime"];
	DOM: CDP.Client["DOM"];
	DOMSnapshot: CDP.Client["DOMSnapshot"];
	Input: CDP.Client["Input"];
	Target: CDP.Client["Target"];
	Accessibility: CDP.Client["Accessibility"];
}

export function installJavaScriptDialogAutoAccept(
	Page: CDP.Client["Page"],
): void {
	Page.javascriptDialogOpening((dialog) => {
		const preview =
			typeof dialog.message === "string"
				? dialog.message.slice(0, 120)
				: "";
		console.warn(
			`[browser] Auto-accepting ${dialog.type} dialog${preview ? `: ${preview}` : ""}`,
		);
		void Page.handleJavaScriptDialog({
			accept: true,
			promptText: "",
		}).catch((error: unknown) => {
			const message =
				error instanceof Error ? error.message : String(error);
			console.warn(
				`[browser] Failed to resolve JavaScript dialog: ${message}`,
			);
		});
	});
}

export async function enableBrowserClientDomains(
	client: CDP.Client,
): Promise<BrowserClientDomains> {
	const { Page, Runtime, DOM, DOMSnapshot, Input, Target, Accessibility } =
		client;
	await Promise.all([
		Page.enable(),
		DOM.enable(),
		DOMSnapshot.enable(),
		Runtime.enable(),
		Accessibility.enable(),
		Target.setDiscoverTargets({ discover: true }),
	]);
	installJavaScriptDialogAutoAccept(Page);
	return {
		Page,
		Runtime,
		DOM,
		DOMSnapshot,
		Input,
		Target,
		Accessibility,
	};
}
