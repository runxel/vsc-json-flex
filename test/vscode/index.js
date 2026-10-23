'use strict';
// Integration tests, executed inside an Extension Development Host by test/vscode-run.js.
// Note: in this mode VS Code auto-answers "Don't Save" to save prompts, so a prompt shows up as a revert.
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, what, ms = 8000) {
	const t = Date.now();
	while (!fn()) {
		if (Date.now() - t > ms) throw new Error('timeout waiting for ' + what);
		await sleep(50);
	}
}

const tabs = () => vscode.window.tabGroups.activeTabGroup.tabs;
const activeInput = () => vscode.window.tabGroups.activeTabGroup.activeTab && vscode.window.tabGroups.activeTabGroup.activeTab.input;
const isTree = () => activeInput() instanceof vscode.TabInputCustom && activeInput().viewType === 'jsonFlex.view';
const isText = () => activeInput() instanceof vscode.TabInputText;

async function setText(doc, text) {
	const edit = new vscode.WorkspaceEdit();
	edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
	await vscode.workspace.applyEdit(edit);
}

async function run() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonflex-'));
	const results = [];
	const step = async (name, fn) => {
		try { await fn(); results.push('PASS ' + name); }
		catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message)); }
	};

	const file = path.join(tmp, 'a.json');
	const original = '{"a":[1,2],"b":{"c":null}}';
	fs.writeFileSync(file, original);
	const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
	const editor = await vscode.window.showTextDocument(doc);
	editor.options = { insertSpaces: false, tabSize: 4 };

	await step('prettify in text editor uses the editor indentation', async () => {
		await vscode.commands.executeCommand('jsonFlex.prettify');
		assert.strictEqual(doc.getText(), '{\n\t"a": [1, 2],\n\t"b": { "c": null }\n}');
	});
	await step('uglify in text editor', async () => {
		await vscode.commands.executeCommand('jsonFlex.uglify');
		assert.strictEqual(doc.getText(), original);
	});
	await step('toggle to tree view replaces the tab (clean doc)', async () => {
		await doc.save();
		await vscode.commands.executeCommand('jsonFlex.toggleView');
		await until(isTree, 'tree view');
		await until(() => tabs().length === 1, 'single tab');
	});
	await step('prettify while the tree view is active (minified: settings indentation)', async () => {
		await vscode.commands.executeCommand('jsonFlex.prettify');
		assert.strictEqual(doc.getText(), '{\n    "a": [1, 2],\n    "b": { "c": null }\n}');
		assert.ok(doc.isDirty);
	});
	await step('toggle with unsaved changes keeps them and both tabs', async () => {
		const before = doc.getText();
		await vscode.commands.executeCommand('jsonFlex.toggleView');
		await until(isText, 'text editor');
		await sleep(300);
		assert.strictEqual(doc.getText(), before);
		assert.ok(doc.isDirty, 'still dirty');
		assert.strictEqual(tabs().length, 2);
	});
	await step('after saving, toggling replaces again', async () => {
		await doc.save();
		await vscode.commands.executeCommand('jsonFlex.toggleView');
		await until(isTree, 'tree view');
		await until(() => tabs().length === 1, 'single tab');
	});
	await step('prettify in tree view detects existing tab indentation', async () => {
		await setText(doc, '{\n\t"a": [1,2],\n\t"b": {"c":null}\n}');
		await vscode.commands.executeCommand('jsonFlex.prettify');
		assert.strictEqual(doc.getText(), '{\n\t"a": [1, 2],\n\t"b": { "c": null }\n}');
	});
	await step('editor/title commands', async () => {
		await doc.save();
		await vscode.commands.executeCommand('jsonFlex.openTextView');
		await until(isText, 'text editor');
		await vscode.commands.executeCommand('jsonFlex.openTreeView');
		await until(isTree, 'tree view');
		await until(() => tabs().length === 1, 'single tab');
	});

	await step('webview loads and handles context menu commands (copy, delete)', async () => {
		// Nodes: 0 root, 1 "a" array, 2 1, 3 2, 4 "b", 5 "c"
		const node = (name, i) => vscode.commands.executeCommand('jsonFlex.node.' + name, { node: i, version: doc.version });
		await vscode.env.clipboard.writeText('');
		const t = Date.now();
		while (await vscode.env.clipboard.readText() !== '[1, 2]') {
			if (Date.now() - t > 10000) throw new Error('webview did not answer copyValue');
			await node('copyValue', 1);
			await sleep(200);
		}
		await node('copyPath', 5);
		await sleep(300);
		assert.strictEqual(await vscode.env.clipboard.readText(), 'b.c');
		await node('delete', 2);
		await sleep(500);
		assert.strictEqual(doc.getText(), '{\n\t"a": [2],\n\t"b": { "c": null }\n}');
		await doc.save();
	});

	await step('large document is formatted in a worker', async () => {
		const big = path.join(tmp, 'big.json');
		const items = [];
		for (let i = 0; i < 40000; i++) items.push(`{"id":${i},"name":"item ${i}","tags":["a","b"],"pos":{"x":${i}.5,"y":-${i}}}`);
		const min = `{"items":[${items.join(',')}]}`;
		fs.writeFileSync(big, min);
		const bdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(big));
		const bed = await vscode.window.showTextDocument(bdoc);
		bed.options = { insertSpaces: true, tabSize: 2 };
		const t0 = Date.now();
		await vscode.commands.executeCommand('jsonFlex.prettify');
		const ms = Date.now() - t0;
		assert.ok(bdoc.getText().startsWith('{\n  "items": [\n    {\n      "id": 0,\n      "name": "item 0",\n      "tags": ["a", "b"],\n      "pos": { "x": 0.5, "y": -0 }\n    },'), bdoc.getText().slice(0, 200));
		results.push(`  (prettify ${(min.length / 1048576).toFixed(1)} MB -> ${(bdoc.getText().length / 1048576).toFixed(1)} MB took ${ms} ms)`);
		await vscode.commands.executeCommand('jsonFlex.toggleView');
		await until(isTree, 'tree view for big doc');
		await vscode.commands.executeCommand('jsonFlex.uglify');
		assert.strictEqual(bdoc.getText(), min);
	});

	await vscode.commands.executeCommand('workbench.action.files.revert');
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	console.log('\n' + results.join('\n') + '\n');
	if (results.some(r => r.startsWith('FAIL'))) throw new Error('integration tests failed');
}

module.exports = { run };
