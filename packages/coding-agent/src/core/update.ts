import { spawn } from "node:child_process";
import {
	APP_NAME,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	VERSION,
} from "../config.js";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export async function checkForNewVersion(currentVersion: string = VERSION): Promise<string | undefined> {
	if (isTruthyEnvFlag(process.env.PI_SKIP_VERSION_CHECK) || isTruthyEnvFlag(process.env.PI_OFFLINE)) {
		return undefined;
	}

	const response = await fetch("https://registry.npmjs.org/@mariozechner/pi-coding-agent/latest", {
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as { version?: string };
	return data.version && data.version !== currentVersion ? data.version : undefined;
}

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
		const child = spawn(command.command, command.args, { stdio });
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
