import type { ExtractDataResultsFromSnapshotResult } from "../data-extraction.js";
import type { ExtractedDataResultItem } from "./extract-data-memory.js";
import {
	appendMemoryResultItems,
	replaceMemoryResultItems,
} from "./memory-file.js";

export const DEFAULT_DATA_EXTRACTION_TIMEOUT_MS = 60_000;

export interface DataExtractionCoordinatorOptions {
	timeoutMs?: number;
}

export interface DataExtractionLaunchInput {
	root: string;
	run: (
		abortSignal: AbortSignal,
	) => Promise<ExtractDataResultsFromSnapshotResult>;
}

export interface DataExtractionLaunchResult {
	sequence: number;
}

export interface DataExtractionBarrierResult {
	errors: string[];
	observations: string[];
	persistedItemCount: number;
}

export interface DataExtractionCoordinatorCheckpoint {
	readonly __dataExtractionCoordinatorCheckpoint: true;
}

type JobStatus = "pending" | "succeeded" | "failed" | "cancelled";

interface ExtractionJob {
	sequence: number;
	generation: number;
	root: string;
	run: DataExtractionLaunchInput["run"];
	deadlineAt: number;
	status: JobStatus;
	items?: ExtractedDataResultItem[];
	error?: string;
	barrierHandled: boolean;
	errorSurfaced: boolean;
	invocation: number;
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	settled: Promise<void>;
	resolveSettled: () => void;
}

interface CheckpointJobState {
	job: ExtractionJob;
	status: JobStatus;
	items?: ExtractedDataResultItem[];
	error?: string;
	barrierHandled: boolean;
	errorSurfaced: boolean;
}

interface CheckpointState {
	nextSequence: number;
	generation: number;
	replaceOnFirstSuccess: boolean;
	jobs: CheckpointJobState[];
}

function createSettledLatch(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function cloneItems(
	items: ExtractedDataResultItem[] | undefined,
): ExtractedDataResultItem[] | undefined {
	return items?.map((item) => ({ ...item }));
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class DataExtractionCoordinator {
	private readonly timeoutMs: number;
	private readonly checkpointStates = new WeakMap<
		DataExtractionCoordinatorCheckpoint,
		CheckpointState
	>();
	private jobs: ExtractionJob[] = [];
	private nextSequence = 1;
	private generation = 1;
	private replaceOnFirstSuccess = false;
	private closed = false;
	private barrierTail: Promise<void> = Promise.resolve();

	constructor(options: DataExtractionCoordinatorOptions = {}) {
		const timeoutMs =
			options.timeoutMs ?? DEFAULT_DATA_EXTRACTION_TIMEOUT_MS;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error("data extraction timeout must be positive");
		}
		this.timeoutMs = timeoutMs;
	}

	launch(input: DataExtractionLaunchInput): DataExtractionLaunchResult {
		this.assertOpen();
		const latch = createSettledLatch();
		const job: ExtractionJob = {
			sequence: this.nextSequence++,
			generation: this.generation,
			root: input.root,
			run: input.run,
			deadlineAt: Date.now() + this.timeoutMs,
			status: "pending",
			barrierHandled: false,
			errorSurfaced: false,
			invocation: 0,
			controller: new AbortController(),
			settled: latch.promise,
			resolveSettled: latch.resolve,
		};
		this.jobs.push(job);
		this.startJob(job);
		return { sequence: job.sequence };
	}

	waitForAllAndFlush(params: {
		filePath: string;
	}): Promise<DataExtractionBarrierResult> {
		const operation = this.barrierTail.then(async () => {
			this.assertOpen();
			return await this.performBarrier(params.filePath);
		});
		this.barrierTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	drainErrors(): string[] {
		const errors: string[] = [];
		for (const job of this.jobs) {
			if (job.status === "failed" && job.error && !job.errorSurfaced) {
				job.errorSurfaced = true;
				errors.push(job.error);
			}
		}
		return errors;
	}

	cancelAndDiscard(options: { prepareReplacement?: boolean } = {}): void {
		this.assertOpen();
		for (const job of this.jobs) this.cancelJob(job);
		this.jobs = [];
		this.generation += 1;
		this.replaceOnFirstSuccess = options.prepareReplacement === true;
	}

	checkpoint(): DataExtractionCoordinatorCheckpoint {
		this.assertOpen();
		const checkpoint = {
			__dataExtractionCoordinatorCheckpoint: true,
		} as const;
		this.checkpointStates.set(checkpoint, {
			nextSequence: this.nextSequence,
			generation: this.generation,
			replaceOnFirstSuccess: this.replaceOnFirstSuccess,
			jobs: this.jobs.map((job) => ({
				job,
				status: job.status,
				items: cloneItems(job.items),
				error: job.error,
				barrierHandled: job.barrierHandled,
				errorSurfaced: job.errorSurfaced,
			})),
		});
		return checkpoint;
	}

	rollback(checkpoint: DataExtractionCoordinatorCheckpoint): void {
		this.assertOpen();
		const state = this.checkpointStates.get(checkpoint);
		if (!state) {
			throw new Error("invalid data extraction coordinator checkpoint");
		}
		this.checkpointStates.delete(checkpoint);
		const checkpointJobs = new Set(state.jobs.map((entry) => entry.job));
		for (const job of this.jobs) {
			if (!checkpointJobs.has(job)) this.cancelJob(job);
		}

		const currentJobs = new Set(this.jobs);
		this.jobs = state.jobs.map((entry) => entry.job);
		for (const entry of state.jobs) {
			const { job } = entry;
			job.barrierHandled = entry.barrierHandled;
			job.errorSurfaced = entry.errorSurfaced;
			if (currentJobs.has(job) && job.status !== "cancelled") {
				continue;
			}
			job.status = entry.status;
			job.items = cloneItems(entry.items);
			job.error = entry.error;
			if (entry.status === "pending") this.startJob(job);
		}
		this.nextSequence = state.nextSequence;
		this.generation = state.generation;
		this.replaceOnFirstSuccess = state.replaceOnFirstSuccess;
	}

	async close(): Promise<void> {
		if (this.closed) {
			await this.barrierTail;
			return;
		}
		this.closed = true;
		const jobs = [...this.jobs];
		for (const job of jobs) this.cancelJob(job);
		this.jobs = [];
		this.replaceOnFirstSuccess = false;
		await Promise.all(jobs.map(async (job) => await job.settled));
		await this.barrierTail;
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("data extraction coordinator is closed");
		}
	}

	private startJob(job: ExtractionJob): void {
		const latch = createSettledLatch();
		job.settled = latch.promise;
		job.resolveSettled = latch.resolve;
		job.status = "pending";
		job.items = undefined;
		job.error = undefined;
		job.controller = new AbortController();
		const invocation = ++job.invocation;
		const remainingMs = job.deadlineAt - Date.now();
		if (remainingMs <= 0) {
			this.failJob(
				job,
				invocation,
				`timed out after ${this.timeoutMs}ms`,
			);
			return;
		}
		job.timer = setTimeout(() => {
			if (job.invocation !== invocation || job.status !== "pending") {
				return;
			}
			job.controller.abort(
				new Error(
					`data extraction timed out after ${this.timeoutMs}ms`,
				),
			);
			this.failJob(
				job,
				invocation,
				`timed out after ${this.timeoutMs}ms`,
			);
		}, remainingMs);
		job.timer.unref?.();

		let result: Promise<ExtractDataResultsFromSnapshotResult>;
		try {
			result = job.run(job.controller.signal);
		} catch (error) {
			this.failJob(job, invocation, toErrorMessage(error));
			return;
		}
		void result.then(
			(extracted) => {
				if (job.invocation !== invocation || job.status !== "pending") {
					return;
				}
				clearTimeout(job.timer);
				job.timer = undefined;
				job.items = cloneItems(extracted.items) ?? [];
				job.status = "succeeded";
				job.resolveSettled();
			},
			(error) => this.failJob(job, invocation, toErrorMessage(error)),
		);
	}

	private failJob(
		job: ExtractionJob,
		invocation: number,
		message: string,
	): void {
		if (job.invocation !== invocation || job.status !== "pending") return;
		clearTimeout(job.timer);
		job.timer = undefined;
		job.status = "failed";
		job.error = `extract_data(root=${job.root}): ${message}`;
		job.resolveSettled();
	}

	private cancelJob(job: ExtractionJob): void {
		if (job.status === "cancelled") return;
		job.invocation += 1;
		clearTimeout(job.timer);
		job.timer = undefined;
		if (job.status === "pending") {
			job.controller.abort(new Error("data extraction cancelled"));
			job.resolveSettled();
		}
		job.status = "cancelled";
		job.items = undefined;
		job.error = undefined;
	}

	private async performBarrier(
		filePath: string,
	): Promise<DataExtractionBarrierResult> {
		const candidates = this.jobs
			.filter((job) => !job.barrierHandled)
			.sort((left, right) => left.sequence - right.sequence);
		await Promise.all(candidates.map(async (job) => await job.settled));

		const activeCandidates = candidates.filter(
			(job) => this.jobs.includes(job) && !job.barrierHandled,
		);
		const succeeded = activeCandidates.filter(
			(job) => job.status === "succeeded",
		);
		const failed = activeCandidates.filter(
			(job) => job.status === "failed",
		);
		const errors = failed.flatMap((job) => (job.error ? [job.error] : []));
		for (const job of failed) {
			job.barrierHandled = true;
			job.errorSurfaced = true;
		}

		let persistedItemCount = 0;
		if (succeeded.length > 0) {
			const items = succeeded.flatMap((job) => job.items ?? []);
			try {
				if (this.replaceOnFirstSuccess) {
					replaceMemoryResultItems({ filePath, items });
					this.replaceOnFirstSuccess = false;
				} else {
					appendMemoryResultItems({ filePath, items });
				}
				persistedItemCount = items.length;
				for (const job of succeeded) job.barrierHandled = true;
			} catch (error) {
				const message = toErrorMessage(error);
				for (const job of succeeded) {
					errors.push(
						`extract_data(root=${job.root}): failed to persist extracted data: ${message}`,
					);
				}
			}
		}

		return {
			errors,
			observations: succeeded
				.filter((job) => job.barrierHandled)
				.map(
					(job) =>
						`extract_data completed asynchronously for ${job.items?.length ?? 0} item(s) (root=${job.root}).`,
				),
			persistedItemCount,
		};
	}
}
