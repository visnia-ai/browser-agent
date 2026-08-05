import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import { AsyncLocalStorage } from "async_hooks";
import { LOGS_DIR } from "./browser/constants.js";

interface TaskLogContext {
	stream: fs.WriteStream;
	writable: boolean;
	filePath: string;
}

const taskLogStore = new AsyncLocalStorage<TaskLogContext>();
let isConsoleTeeInstalled = false;
let suppressConsoleWhenTaskLogging = false;

function sanitizeForFilename(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized.slice(0, 60) || "task";
}

export function installTaskLogConsoleTee(options?: {
	suppressConsoleWhenTaskLogging?: boolean;
}): void {
	if (options?.suppressConsoleWhenTaskLogging !== undefined) {
		suppressConsoleWhenTaskLogging = options.suppressConsoleWhenTaskLogging;
	}

	if (isConsoleTeeInstalled) {
		return;
	}

	const originalConsoleLog = console.log.bind(console);
	console.log = (...args: unknown[]) => {
		const context = taskLogStore.getStore();
		const shouldPrintToConsole = !(
			context && suppressConsoleWhenTaskLogging
		);
		if (shouldPrintToConsole) {
			originalConsoleLog(...args);
		}

		if (!context || !context.writable) {
			return;
		}

		const line = util.format(...args);
		context.stream.write(`[${new Date().toISOString()}] ${line}\n`);
	};

	isConsoleTeeInstalled = true;
}

export function resetTaskLogsDir(enabled: boolean, logsDir = LOGS_DIR): void {
	if (fs.existsSync(logsDir)) {
		fs.rmSync(logsDir, { recursive: true });
	}
	if (enabled) {
		fs.mkdirSync(logsDir, { recursive: true });
	}
}

export async function withTaskLogContext<T>(
	taskNumber: number,
	task: string,
	enabled: boolean,
	fn: () => Promise<T>,
	logsDir = LOGS_DIR,
): Promise<T> {
	if (!enabled) {
		return fn();
	}

	const fileName = `task-${String(taskNumber).padStart(3, "0")}-${sanitizeForFilename(task)}.log`;
	const filePath = path.join(logsDir, fileName);
	let context: TaskLogContext;
	try {
		fs.mkdirSync(logsDir, { recursive: true });
		context = await openTaskLog(filePath);
	} catch (error) {
		process.stderr.write(
			`[task-log] unable to open ${filePath}; continuing without a task log: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return fn();
	}
	const { stream } = context;
	stream.write(`[${new Date().toISOString()}] Task ${taskNumber}: ${task}\n`);

	try {
		return await taskLogStore.run(context, fn);
	} finally {
		if (!stream.destroyed && !stream.writableEnded) {
			await new Promise<void>((resolve) => stream.end(resolve));
		}
	}
}

async function openTaskLog(filePath: string): Promise<TaskLogContext> {
	const stream = fs.createWriteStream(filePath, { flags: "w" });
	const context: TaskLogContext = { stream, writable: true, filePath };
	await new Promise<void>((resolve, reject) => {
		const handleOpen = () => {
			stream.off("error", handleOpenError);
			resolve();
		};
		const handleOpenError = (error: Error) => {
			stream.off("open", handleOpen);
			reject(error);
		};
		stream.once("open", handleOpen);
		stream.once("error", handleOpenError);
	});
	stream.on("error", (error) => {
		if (!context.writable) return;
		context.writable = false;
		process.stderr.write(
			`[task-log] write failed for ${context.filePath}; continuing without this task log: ${error.message}\n`,
		);
	});
	return context;
}
