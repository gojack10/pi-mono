import { spawn } from "node:child_process";
import { APP_NAME, getSelfUpdateCommand, getSelfUpdateUnavailableInstruction, PACKAGE_NAME } from "../config.js";

export function canSelfUpdate(): boolean {
	return getSelfUpdateCommand(PACKAGE_NAME) !== undefined;
}

export function getSelfUpdateDisplay(): string | undefined {
	return getSelfUpdateCommand(PACKAGE_NAME)?.display;
}

export function getSelfUpdateUnavailableMessage(): string {
	return `${APP_NAME} cannot self-update this installation. ${getSelfUpdateUnavailableInstruction(PACKAGE_NAME)}`;
}

export async function installSelfUpdate(stdio: "inherit" | "ignore" = "inherit"): Promise<void> {
	const command = getSelfUpdateCommand(PACKAGE_NAME);
	if (!command) {
		throw new Error(getSelfUpdateUnavailableMessage());
	}

	await new Promise<void>((resolve, reject) => {
		// Windows package managers are commonly .cmd shims. Use the shell so Node can execute them;
		// command and args come from getSelfUpdateCommandForMethod(), not user input.
		const child = spawn(command.command, command.args, { stdio, shell: process.platform === "win32" });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve();
			} else if (signal) {
				reject(new Error(`${command.display} terminated by signal ${signal}`));
			} else {
				reject(new Error(`${command.display} exited with code ${code ?? "unknown"}`));
			}
		});
	});
}
