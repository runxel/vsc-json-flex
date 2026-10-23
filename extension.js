'use strict';
const vscode = require('vscode');
const { FlexEditorProvider, VIEW_TYPE } = require('./src/flexEditor');
const { formatDocument } = require('./src/format');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	const provider = new FlexEditorProvider(context);

	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
			// Re-parsing a multi-MB document on every tab switch would be far slower than keeping the webview alive.
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: true,
		}),
		vscode.commands.registerCommand('jsonFlex.prettify', (uri) => formatDocument('prettify', uri, provider)),
		vscode.commands.registerCommand('jsonFlex.uglify', (uri) => formatDocument('uglify', uri, provider)),
		vscode.commands.registerCommand('jsonFlex.toggleView', () => toggleView()),
		vscode.commands.registerCommand('jsonFlex.openTreeView', () => toggleView(true)),
		vscode.commands.registerCommand('jsonFlex.openTextView', () => toggleView(false)),
	);
	for (const name of ['editValue', 'editKey', 'addAfter', 'addChild', 'delete', 'copyValue', 'copyPath']) {
		// Webview context menu: the argument is the row's data-vscode-context object.
		context.subscriptions.push(vscode.commands.registerCommand('jsonFlex.node.' + name, (ctx) => provider.forwardNodeCommand(name, ctx)));
	}
}

/**
 * Switches the active tab between the text editor and the tree view (in place, same tab position).
 * @param {boolean} [toTree] undefined = toggle
 */
async function toggleView(toTree) {
	const group = vscode.window.tabGroups.activeTabGroup;
	const tab = group.activeTab;
	const input = tab && tab.input;
	let uri, isTree;
	if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) { uri = input.uri; isTree = true; }
	else if (input instanceof vscode.TabInputText) { uri = input.uri; isTree = false; }
	else return void vscode.window.showInformationMessage('JSON Flex: open a JSON file first.');
	if (toTree === undefined) toTree = !isTree;
	if (toTree === isTree) return;

	const key = uri.toString();
	const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
	await vscode.commands.executeCommand('vscode.openWith', uri, toTree ? VIEW_TYPE : 'default', { viewColumn: group.viewColumn, preview: tab.isPreview });
	// openWith adds a second tab for the same resource; close the old one so this behaves like a toggle.
	// Not if the document is dirty: VS Code then asks to save (and "Don't Save" reverts the document for
	// both editors) - even its own "Reopen Editor With" does that. So keep both tabs in that case.
	if (doc && doc.isDirty) return;
	// Tab objects are replaced when the group changes, so look the old one up again.
	const old = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.group.viewColumn === group.viewColumn && (isTree
		? t.input instanceof vscode.TabInputCustom && t.input.viewType === VIEW_TYPE && t.input.uri.toString() === key
		: t.input instanceof vscode.TabInputText && t.input.uri.toString() === key));
	if (old) await vscode.window.tabGroups.close(old, true);
}

function deactivate() { }

module.exports = { activate, deactivate };
