/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcessResult } from "../utils/child-process.ts";
import { Failure, type Result, Success } from "./result.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** Safe failure details returned by execChecked(). Command arguments are excluded. */
export interface ExecFailure {
	command: string;
	code: number;
	killed: boolean;
	signal?: NodeJS.Signals;
	diagnostic?: string;
}

export type CheckedExecResult = Result<ExecResult, ExecFailure>;

const boundedDiagnostic = (value: string): string | undefined => {
	const diagnostic = value
		.replace(/\b(api[_-]?key|token|password|secret|authorization)\b(\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1$2[redacted]")
		.replace(/[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
		.replace(/[\r\n\t]+/g, " ")
		.trim()
		.slice(0, 1024);
	return diagnostic || undefined;
};

const commandName = (command: string): string => {
	const name = command.split(/[\\/]/).at(-1) || command;
	return (
		name
			.replace(/[\0\x01-\x1f\x7f]/g, " ")
			.trim()
			.slice(0, 128) || "command"
	);
};

interface ExecResultWithSignal {
	result: ExecResult;
	signal: NodeJS.Signals | null;
}

/** Execute a shell command as a checked result without changing raw execution semantics. */
export async function execChecked(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<CheckedExecResult> {
	const { result, signal } = await execCommandWithSignal(command, args, cwd, options);
	if (result.code === 0 && !result.killed && signal === null) return Success(result);

	const error: ExecFailure = {
		command: commandName(command),
		code: result.code,
		killed: result.killed,
		diagnostic: boundedDiagnostic(result.stderr),
	};
	if (signal !== null) error.signal = signal;
	return Failure(error);
}

async function execCommandWithSignal(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResultWithSignal> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcessResult(proc)
			.then(({ code, signal }) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ result: { stdout, stderr, code: code ?? 0, killed }, signal });
			})
			.catch((_err) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ result: { stdout, stderr, code: 1, killed }, signal: null });
			});
	});
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return (await execCommandWithSignal(command, args, cwd, options)).result;
}
