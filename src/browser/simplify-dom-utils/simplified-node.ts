export interface SimplifiedNode {
	tag: string;
	attrs: [string, string][];
	text: string;
	children: SimplifiedNode[];
	isHidden: boolean;
	couldBeHidden?: boolean;
	isInteractive: boolean;
	/** Present when computed cursor is not-allowed / no-drop (still interactive for targeting). */
	noClickAllowed?: boolean;
	/** Present when overflow style enables scrolling on at least one axis. */
	scrollEnabled?: boolean;
	/** Present when content currently overflows client bounds on at least one axis. */
	scrollable?: boolean;
	/** Present when this node represents an omitted subtree outside the viewport overscan. */
	outsideViewport?: {
		direction: "above" | "below";
		scrollDeltaY: number;
	};
}
