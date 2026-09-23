#!/usr/bin/env node

/**
 * pi-subagents-cc installer (independent fork, omp-style: not a GitHub fork)
 * Base: nicobailon/pi-subagents — Claude Code style: tintinweb/pi-subagents
 *
 * Usage:
 *   npx pi-subagents-cc          # Install to ~/.pi/agent/extensions/subagent-cc
 *   npx pi-subagents-cc --remove # Remove the extension
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent-cc");
const REPO_URL = "https://github.com/ttaatoo/pi-subagents-cc.git";

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isHelp = args.includes("--help") || args.includes("-h");

if (isHelp) {
	console.log(`
pi-subagents-cc - Pi extension for Claude Code-style subagents (fork of nicobailon/pi-subagents)

Usage:
  npx pi-subagents-cc          Install the extension
  npx pi-subagents-cc --remove Remove the extension
  npx pi-subagents-cc --help   Show this help

Installation directory: ${EXTENSION_DIR}
`);
	process.exit(0);
}

if (isRemove) {
	if (fs.existsSync(EXTENSION_DIR)) {
		console.log(`Removing ${EXTENSION_DIR}...`);
		fs.rmSync(EXTENSION_DIR, { recursive: true });
		console.log("pi-subagents-cc removed");
	} else {
		console.log("pi-subagents-cc is not installed");
	}
	process.exit(0);
}

// Install
console.log("Installing pi-subagents-cc...\n");

// Ensure parent directory exists
const parentDir = path.dirname(EXTENSION_DIR);
if (!fs.existsSync(parentDir)) {
	fs.mkdirSync(parentDir, { recursive: true });
}

// Check if already installed
if (fs.existsSync(EXTENSION_DIR)) {
	const isGitRepo = fs.existsSync(path.join(EXTENSION_DIR, ".git"));
	if (isGitRepo) {
		console.log("Updating existing installation...");
		try {
			execSync("git pull", { cwd: EXTENSION_DIR, stdio: "inherit" });
			console.log("\npi-subagents-cc updated");
		} catch (err) {
			console.error("Failed to update. Try removing and reinstalling:");
			console.error("  npx pi-subagents-cc --remove && npx pi-subagents-cc");
			process.exit(1);
		}
	} else {
		console.log(`Directory exists but is not a git repo: ${EXTENSION_DIR}`);
		console.log("Remove it first with: npx pi-subagents-cc --remove");
		process.exit(1);
	}
} else {
	// Fresh install
	console.log(`Cloning to ${EXTENSION_DIR}...`);
	try {
		execSync(`git clone ${REPO_URL} "${EXTENSION_DIR}"`, { stdio: "inherit" });
		console.log("\npi-subagents-cc installed");
	} catch (err) {
		console.error("Failed to clone repository");
		process.exit(1);
	}
}

console.log(`
The extension is now available in pi. Tools added:
  • subagent - Delegate tasks to agents and inspect run status
  • bg_wait - Wait for background/provider/detached work without native completion notifications

Documentation: ${EXTENSION_DIR}/README.md
`);
