import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Tab } from "../browser/types.js";
import type { ChecklistItem } from "../agents/types.js";
import type { SessionAuthTakeoverState } from "../auth/types.js";
import type { DataExtractionCoordinator } from "../agents/executor-utils/data-extraction-coordinator.js";

export interface BrowserSession {
	port: number;
	headless: boolean;
	browser: Browser;
	memoryFile: string;
	extractDataMemoryFile: string;
	dataExtractionCoordinator: DataExtractionCoordinator;
	pinnedMemoryContent?: string;
	preparedPasteFiles: string[];
	activeChecklist: ChecklistItem[];
	lastTask: string | null;
	pendingMemoryRead: boolean;
	previousInteractionErrors: string[];
	previousToolObservations: string[];
	previousStepTabs: Tab[] | null;
	downloadedFileSignatures: Map<string, string> | null;
	downloadedNewFilePaths: Set<string>;
	authTakeover?: SessionAuthTakeoverState;
	lastActionSignatureWithUrl: string | null;
	lastProgressSignature: string | null;
	sameActionSignatureStreak: number;
	noProgressStreak: number;
	projectionHistory: {
		committed?: ProjectionHistorySnapshot;
		pending?: ProjectionHistorySnapshot;
	};
}

export interface ProjectionHistorySnapshot {
	canonicalProjection: string;
	sourceHistoryLength: number;
	canDiffFrom: boolean;
}

export class SessionRegistry {
	private readonly sessions = new Map<number, BrowserSession>();

	has(port: number): boolean {
		return this.sessions.has(port);
	}

	get(port: number): BrowserSession | undefined {
		return this.sessions.get(port);
	}

	set(session: BrowserSession): void {
		this.sessions.set(session.port, session);
	}

	delete(port: number): void {
		this.sessions.delete(port);
	}

	values(): BrowserSession[] {
		return [...this.sessions.values()];
	}
}

function createEmptySessionMemoryFile(
	port: number,
	filePrefix: string,
): string {
	const dir = path.join(os.tmpdir(), "browser-agent-server-memory");
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${filePrefix}-port-${port}.txt`);
	fs.writeFileSync(filePath, "", "utf-8");
	return filePath;
}

export function createSessionMemoryFile(port: number): string {
	return createEmptySessionMemoryFile(port, "memory");
}

export function createSessionExtractDataMemoryFile(port: number): string {
	return createEmptySessionMemoryFile(port, "extract-data-memory");
}
