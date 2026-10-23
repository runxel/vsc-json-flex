'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const vscode = require('vscode');
const { run } = require('./formatCore');
const { positionAt, detectIndent } = require('../lib/jsonc');

// Above this size formatting runs in a worker thread with a cancellable progress notification,
// so the extension host (and every other extension in it) stays responsive.
const WORKER_THRESHOLD = 512 * 1024;

/**
 * Prettify / uglify a whole document.
 * @param {'prettify'|'uglify'} mode
 * @param {vscode.Uri} [uri] passed by editor/title and context menus
 * @param {import('./flexEditor').FlexEditorProvider} provider
 */
async function formatDocument(mode, uri, provider) {
	const document = await resolveDocument(uri, provider);
	if (!document) return void vscode.window.showInformationMessage('JSON Flex: no JSON document to format.');

	const text = document.getText();
	const version = document.version;
	const opts = mode === 'prettify' ? prettifyOptions(document, text) : {};

	let result;
	try {
		result = text.length < WORKER_THRESHOLD ? run(mode, text, opts) : await runInWorker(mode, text, opts);
	} catch (err) {
		return void vscode.window.showErrorMessage(`JSON Flex: ${mode} failed: ${err && err.message || err}`);
	}
	if (!result) return; // cancelled

	if (result.error) {
		const pos = positionAt(text, result.error.offset);
		const choice = await vscode.window.showWarningMessage(
			`JSON Flex: ${result.error.message} at line ${pos.line + 1}, column ${pos.character + 1}. ${mode === 'prettify' ? 'Prettify' : 'Uglify'} anyway?`,
			'Format Anyway', 'Go to Error');
		if (choice === 'Go to Error') {
			const p = new vscode.Position(pos.line, pos.character);
			await vscode.window.showTextDocument(document, { selection: new vscode.Range(p, p) });
			return;
		}
		if (choice !== 'Format Anyway') return;
	}
	if (result.text === text) return void vscode.window.setStatusBarMessage('JSON Flex: nothing to change', 3000);
	if (document.version !== version) {
		return void vscode.window.showWarningMessage('JSON Flex: the document changed while formatting. Please try again.');
	}
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), result.text);
	await vscode.workspace.applyEdit(edit);
}

async function resolveDocument(uri, provider) {
	if (uri instanceof vscode.Uri) {
		const key = uri.toString();
		return vscode.workspace.textDocuments.find(d => d.uri.toString() === key) || vscode.workspace.openTextDocument(uri);
	}
	const active = provider.activeDocument();
	if (active) return active;
	const editor = vscode.window.activeTextEditor;
	return editor && editor.document;
}

function prettifyOptions(document, text) {
	const cfg = vscode.workspace.getConfiguration('jsonFlex.prettify', document);
	const mode = cfg.get('indent', 'editor');
	const { indent, tabSize } = mode === 'editor' ? editorIndent(document, text)
		: mode === 'tab' ? { indent: '\t', tabSize: 4 } : { indent: ' '.repeat(Number(mode)), tabSize: Number(mode) };
	return {
		indent,
		tabSize,
		eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
		maxInlineWidth: cfg.get('maxInlineWidth', 80),
		inlineObjects: cfg.get('inlineObjects', true),
	};
}

/**
 * Effective indentation for a document. A visible text editor knows it (indentation detection, EditorConfig);
 * otherwise (tree view only) detect it from the text like VS Code does, then fall back to the settings.
 * @returns {{ indent: string, tabSize: number }}
 */
function editorIndent(document, text) {
	const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
	const ecfg = vscode.workspace.getConfiguration('editor', document);
	let tabSize = Number(editor ? editor.options.tabSize : ecfg.get('tabSize', 4)) || 4;
	let insertSpaces = editor ? editor.options.insertSpaces : ecfg.get('insertSpaces', true);
	if (!editor && ecfg.get('detectIndentation', true)) {
		const detected = detectIndent(text);
		if (detected === '\t') insertSpaces = false;
		else if (detected) { insertSpaces = true; tabSize = detected.length; }
	}
	return { indent: insertSpaces ? ' '.repeat(tabSize) : '\t', tabSize };
}

function runInWorker(mode, text, opts) {
	const title = mode === 'prettify' ? 'Prettifying JSON…' : 'Uglifying JSON…';
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (_progress, token) =>
		new Promise((resolve, reject) => {
			const worker = new Worker(path.join(__dirname, 'formatWorker.js'), { workerData: { mode, text, opts } });
			const sub = token.onCancellationRequested(() => { worker.terminate(); resolve(null); });
			worker.once('message', (msg) => { sub.dispose(); worker.terminate(); resolve(msg); });
			worker.once('error', (err) => { sub.dispose(); reject(err); });
		}));
}

module.exports = { formatDocument, editorIndent };
