'use strict';
// Runs test/vscode/index.js inside an Extension Development Host:  node test/vscode-run.js
// Uses $CODE, else VS Code Insiders, else VS Code. Stable VS Code refuses to run tests while another
// instance of the same build is open, so Insiders is preferred when you have stable open (or vice versa).
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const code = process.env.CODE || [
	'/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron',
	'/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
].find(p => fs.existsSync(p));
if (!code) { console.error('VS Code not found; set CODE to its executable.'); process.exit(2); }

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonflex-ud-'));
const r = spawnSync(code, [
	'--extensionDevelopmentPath=' + root,
	'--extensionTestsPath=' + (process.env.TESTS || path.join(__dirname, 'vscode', 'index.js')),
	'--user-data-dir=' + userData,
	'--disable-extensions',
	'--disable-workspace-trust',
	'--skip-welcome',
	'--skip-release-notes',
	'--new-window',
], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
fs.rmSync(userData, { recursive: true, force: true });
process.exit(r.status === null ? 1 : r.status);
