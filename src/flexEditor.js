'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { formatDocument, editorIndent } = require('./format');

const VIEW_TYPE = 'jsonFlex.view';
// Webview markup lives in a file so the browser test harness (test/harness.js) can use the same one.
const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'media', 'body.html'), 'utf8');

/**
 * Custom text editor hosting the tree view webview. The TextDocument stays the single source of truth:
 * the webview gets the full text once and then incremental content changes; edits made in the webview
 * come back as offset-based replacements and are applied as WorkspaceEdits (so undo/redo, dirty state
 * and saving all work as in the text editor).
 */
class FlexEditorProvider {
	/** @param {vscode.ExtensionContext} context */
	constructor(context) {
		this.context = context;
		/** @type {Set<{ document: vscode.TextDocument, panel: vscode.WebviewPanel }>} */
		this.views = new Set();
	}

	activeView() {
		for (const v of this.views) if (v.panel.active) return v;
		// panel.active is updated asynchronously; the active tab is authoritative.
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const input = tab && tab.input;
		if (!(input instanceof vscode.TabInputCustom) || input.viewType !== VIEW_TYPE) return undefined;
		const key = input.uri.toString();
		for (const v of this.views) if (v.document.uri.toString() === key && v.panel.viewColumn === tab.group.viewColumn) return v;
		return undefined;
	}

	activeDocument() {
		const v = this.activeView();
		return v && v.document;
	}

	/** Context menu commands are executed by the workbench; route them to the webview that owns the row. */
	forwardNodeCommand(name, ctx) {
		const v = this.activeView();
		if (v && ctx) v.panel.webview.postMessage({ type: 'nodeCommand', name, node: ctx.node, version: ctx.version });
	}

	/**
	 * @param {vscode.TextDocument} document
	 * @param {vscode.WebviewPanel} panel
	 */
	resolveCustomTextEditor(document, panel) {
		const view = { document, panel };
		this.views.add(view);
		const webview = panel.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'lib'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webview.html = this.html(webview);

		const post = (msg) => webview.postMessage(msg);
		const subs = [
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.document !== document || e.contentChanges.length === 0) return;
				if (e.contentChanges.length === 1) {
					const c = e.contentChanges[0];
					post({ type: 'change', version: document.version, offset: c.rangeOffset, length: c.rangeLength, text: c.text });
				} else {
					post({ type: 'replace', version: document.version, text: document.getText() });
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('jsonFlex') || e.affectsConfiguration('editor')) post({ type: 'config', config: this.config(document) });
			}),
			webview.onDidReceiveMessage((msg) => this.onMessage(view, msg)),
		];
		panel.onDidDispose(() => {
			this.views.delete(view);
			for (const s of subs) s.dispose();
		});
	}

	async onMessage({ document, panel }, msg) {
		const post = (m) => panel.webview.postMessage(m);
		switch (msg.type) {
			case 'ready':
			case 'resync':
				post({ type: 'init', text: document.getText(), version: document.version, config: this.config(document) });
				break;
			case 'edit': {
				if (msg.version !== document.version) return void post({ type: 'editRejected' });
				const edit = new vscode.WorkspaceEdit();
				for (const e of msg.edits) {
					edit.replace(document.uri, new vscode.Range(document.positionAt(e.offset), document.positionAt(e.offset + e.length)), e.text);
				}
				if (!(await vscode.workspace.applyEdit(edit))) post({ type: 'editRejected' });
				break;
			}
			case 'format':
				await formatDocument(msg.mode, document.uri, this);
				break;
			case 'openText':
				await vscode.commands.executeCommand('jsonFlex.openTextView');
				break;
			case 'copy':
				await vscode.env.clipboard.writeText(msg.text);
				vscode.window.setStatusBarMessage(`JSON Flex: copied ${msg.what || 'value'}`, 2000);
				break;
			case 'openUrl':
				if (/^https?:\/\//i.test(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
				break;
			case 'notify':
				vscode.window.showWarningMessage('JSON Flex: ' + msg.text);
				break;
		}
	}

	config(document) {
		const fcfg = vscode.workspace.getConfiguration('jsonFlex', document);
		return {
			indent: editorIndent(document, document.getText()).indent,
			eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
			keyColumnWidth: fcfg.get('tree.keyColumnWidth', 260),
		};
	}

	html(webview) {
		const nonce = crypto.randomBytes(16).toString('base64');
		const uri = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('media', 'view.css')}" rel="stylesheet">
<title>JSON Flex</title>
</head>
<body>
${TEMPLATE}
<script nonce="${nonce}" src="${uri('lib', 'jsonc.js')}"></script>
<script nonce="${nonce}" src="${uri('media', 'view.js')}"></script>
</body>
</html>`;
	}
}

module.exports = { FlexEditorProvider, VIEW_TYPE };
