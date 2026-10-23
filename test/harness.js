'use strict';
// Runs the tree view webview in a normal browser, with a fake VS Code host that applies edits to an
// in-memory document. Useful for UI work without launching the Extension Development Host.
//
//   node test/harness.js [file.json]            writes test/harness.html (open it in a browser)
//   node test/harness.js [file.json] --selftest  also runs scripted UI checks in headless Chromium/Chrome
//                                                (set CHROME=/path/to/binary if not auto-detected)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const selftest = args.includes('--selftest');
const file = args.find(a => !a.startsWith('--')) || path.join(__dirname, 'test.json');
const out = path.join(__dirname, 'harness.html');

const doc = fs.readFileSync(file, 'utf8');
const body = fs.readFileSync(path.join(root, 'media', 'body.html'), 'utf8');
const rel = (p) => path.relative(__dirname, path.join(root, p)).split(path.sep).join('/');

// Minimal stand-in for the variables VS Code injects into webviews (Dark Modern-ish).
const themeVars = `
	--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --vscode-font-size: 13px;
	--vscode-editor-font-family: Menlo, Consolas, monospace; --vscode-editor-font-size: 13px;
	--vscode-editor-foreground: #ccc; --vscode-editor-background: #1f1f1f;
	--vscode-button-secondaryForeground: #ccc; --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryHoverBackground: #3c3c3c;
	--vscode-input-foreground: #ccc; --vscode-input-background: #313131; --vscode-input-border: #3c3c3c; --vscode-focusBorder: #0078d4;
	--vscode-list-hoverBackground: #2a2d2e; --vscode-list-activeSelectionBackground: #04395e; --vscode-list-inactiveSelectionBackground: #37373d;
	--vscode-panel-border: #2b2b2b;`;

const host = `
window.__doc = ${JSON.stringify(doc)};
window.__ver = 1;
window.__log = [];
(function () {
	const post = (m) => window.postMessage(m, '*');
	const config = { indent: '\\t', eol: '\\n', keyColumnWidth: 220 };
	window.__hostChange = (offset, length, text) => {
		window.__doc = window.__doc.slice(0, offset) + text + window.__doc.slice(offset + length);
		post({ type: 'change', version: ++window.__ver, offset, length, text });
	};
	window.acquireVsCodeApi = () => ({
		getState: () => null,
		setState: () => {},
		postMessage: (m) => setTimeout(() => {
			window.__log.push(m.type);
			switch (m.type) {
				case 'ready': case 'resync':
					post({ type: 'init', text: window.__doc, version: window.__ver, config }); break;
				case 'edit': {
					if (m.version !== window.__ver) { post({ type: 'editRejected' }); break; }
					const e = m.edits[0];
					window.__hostChange(e.offset, e.length, e.text);
					break;
				}
				case 'format': {
					const old = window.__doc;
					const next = m.mode === 'prettify' ? JSONC.prettify(old, config) : JSONC.uglify(old);
					if (next !== old) window.__hostChange(0, old.length, next);
					break;
				}
				case 'copy': window.__copied = m.text; break;
				default: console.log('host <-', JSON.stringify(m));
			}
		}, 0),
	});
})();`;

// Scripted checks; results are written into #selftest for --dump-dom.
const tests = `
(async function () {
	const out = [];
	const sleep = (ms) => new Promise(r => setTimeout(r, ms));
	const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };
	const rows = () => [...document.querySelectorAll('#rows .row')];
	// Shallowest row with that key.
	const rowByKey = (k) => rows().filter(r => { const e = r.querySelector('.key'); return e && e.textContent === k; })
		.sort((a, b) => parseInt(a.firstChild.style.paddingLeft) - parseInt(b.firstChild.style.paddingLeft))[0];
	const key = (k, opts = {}) => document.getElementById('scroller').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
	const check = (name, ok, extra) => out.push((ok ? 'PASS ' : 'FAIL ') + name + (ok || extra === undefined ? '' : ' :: ' + extra));
	const mod = navigator.platform.toUpperCase().includes('MAC') ? { metaKey: true } : { ctrlKey: true };
	const docObj = () => JSON.parse(window.__doc);
	const typeInto = async (value) => {
		const input = document.querySelector('input.edit');
		input.value = value;
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await sleep(60);
	};
	try {
		await until(() => rows().length > 0);
		check('renders rows', rows().length > 3, rows().length);
		const total = document.getElementById('spacer').offsetHeight + document.getElementById('scroller').clientHeight;
		check('virtualised: DOM rows << nodes', rows().length < 80, rows().length);

		document.getElementById('btn-collapse').click(); await sleep(30);
		check('collapse all', rows().length === 3, rows().map(r => r.textContent).join(' | '));
		document.getElementById('btn-expand').click(); await sleep(30);
		check('expand all', rows().length > 3);

		// Filter
		const f = document.getElementById('filter');
		f.value = 'EPSG'; f.dispatchEvent(new Event('input')); await sleep(250);
		check('filter shows match + ancestors', rows().length === 3 && rows()[2].querySelector('mark'), rows().map(r => r.textContent).join(' | '));
		check('filter count', document.getElementById('filter-count').textContent === '1 match', document.getElementById('filter-count').textContent);
		f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(30);
		check('filter cleared', rows().length > 3);

		// Edit a value: select "type" (2nd top-level row) and change it.
		rowByKey('type').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		key('Enter'); await sleep(20);
		check('edit input opens with raw JSON', document.querySelector('input.edit') && document.querySelector('input.edit').value === '"FeatureCollection"');
		await typeInto('Collection of "things"');
		check('invalid JSON is stored as string', docObj().type === 'Collection of "things"', docObj().type);
		check('selection kept after edit', document.querySelector('.row.sel') && document.querySelector('.row.sel').textContent.startsWith('type'), document.querySelector('.row.sel') && document.querySelector('.row.sel').textContent);
		key('Enter'); await sleep(20); await typeInto('42');
		check('valid JSON changes type', docObj().type === 42, window.__doc.slice(0, 120));

		// Rename key
		key('F2'); await sleep(20); await typeInto('kind');
		check('rename key', docObj().kind === 42 && !('type' in docObj()), Object.keys(docObj()).join(','));

		// Add after, edit new key (cursor jumps into the new row)
		key('Enter', mod); await sleep(80);
		const inp = document.querySelector('input.edit');
		check('add after opens key editor', inp && inp.value === 'key', inp && inp.value);
		await typeInto('added');
		check('add after', Object.keys(docObj()).join(',') === 'crs,kind,added,features', Object.keys(docObj()).join(','));

		// Delete
		key('Delete'); await sleep(80);
		check('delete', Object.keys(docObj()).join(',') === 'crs,kind,features', Object.keys(docObj()).join(','));
		check('doc still valid', JSONC.validate(window.__doc) === null);

		// Collapse state survives an edit elsewhere
		const crs = rowByKey('crs');
		crs.querySelector('.tw').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(20);
		const n1 = rows().length;
		rowByKey('kind').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		key('Enter'); await sleep(20); await typeInto('true');
		check('collapse state kept after edit', rows().length === n1 && rowByKey('crs').querySelector('.tw.c'), rows().length + ' vs ' + n1);

		// External change (e.g. typed in the text editor), then prettify keeps collapse state by index
		window.__hostChange(1, 0, ' '); await sleep(60);
		check('external change applied', document.getElementById('status').textContent.includes('nodes'));
		document.getElementById('btn-prettify').click(); await sleep(150);
		check('prettify via toolbar', window.__doc.includes('\\n\\t"crs": {'), window.__doc.slice(0, 80));
		check('collapse state kept after prettify', rowByKey('crs') && rowByKey('crs').querySelector('.tw.c'));

		// Add child to empty array uses line-based layout
		window.__hostChange(window.__doc.indexOf('"kind": true') + 8, 4, '[]'); await sleep(60);
		const kindRow = rowByKey('kind');
		kindRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		key('Enter', { ...mod, shiftKey: true }); await sleep(80);
		await typeInto('"x"');
		check('add child to empty array', JSON.stringify(docObj().kind) === '["x"]' && window.__doc.includes('"kind": [\\n\\t\\t"x"\\n\\t]'), window.__doc.slice(0, 200));

		// Delete last element of an array keeps it valid
		window.__hostChange(window.__doc.indexOf('"x"') + 3, 0, ',\\n\\t\\t"y"'); await sleep(60);
		rowByKey('1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		key('Delete'); await sleep(80);
		check('delete last element', JSON.stringify(docObj().kind) === '["x"]' && window.__doc.includes('"kind": [\\n\\t\\t"x"\\n\\t]'), window.__doc.slice(0, 200));

		// Copy path
		document.getElementById('btn-expand').click(); await sleep(20);
		rowByKey('name').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		window.postMessage({ type: 'nodeCommand', name: 'copyPath', node: +document.querySelector('.row.sel').dataset.i, version: window.__ver }, '*');
		await sleep(30);
		check('copy path', window.__copied === 'crs.properties.name', window.__copied);

		// Syntax error banner
		window.__hostChange(0, 0, 'x'); await sleep(60);
		check('error banner', !document.getElementById('banner').hidden, document.getElementById('banner').textContent);
		window.__hostChange(0, 1, ''); await sleep(60);
		check('error banner hidden again', document.getElementById('banner').hidden);
	} catch (e) {
		out.push('FAIL exception: ' + e.stack);
	}
	document.getElementById('selftest').textContent = out.join('\\n');
})();`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>JSON Flex harness</title>
<link rel="stylesheet" href="${rel('media/view.css')}">
<style>:root {${themeVars} } #selftest { display: none; }</style>
</head>
<body class="vscode-dark">
${body}
<pre id="selftest"></pre>
<script>${host}</script>
<script src="${rel('lib/jsonc.js')}"></script>
<script src="${rel('media/view.js')}"></script>
${selftest ? `<script>${tests}</script>` : ''}
</body>
</html>`;

fs.writeFileSync(out, html);
console.log('wrote', out);

if (selftest) {
	const chrome = process.env.CHROME || [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/usr/bin/chromium', '/usr/bin/google-chrome',
	].find(p => fs.existsSync(p));
	if (!chrome) { console.error('No Chrome/Chromium found; set CHROME.'); process.exit(2); }
	const dom = execFileSync(chrome, ['--headless', '--disable-gpu', '--allow-file-access-from-files', '--virtual-time-budget=20000', '--window-size=1000,700', '--dump-dom', 'file://' + out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	const m = /<pre id="selftest">([\s\S]*?)<\/pre>/.exec(dom);
	const result = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : '(no output)';
	console.log(result);
	process.exit(/FAIL|no output/.test(result) || !result.trim() ? 1 : 0);
}
