'use strict';
// Tree view webview. Holds a copy of the document text, parses it into flat node tables (lib/jsonc.js) and
// renders only the rows inside the viewport (virtual scrolling), so multi-MB documents stay smooth.
// All edits are sent to the extension host as offset-based replacements; the resulting document change comes
// back as a 'change' message and is the only way the text here is ever modified.
(function () {
	const vscode = acquireVsCodeApi();
	const J = window.JSONC;
	const NT = J.NodeType;
	const $ = (id) => document.getElementById(id);
	const el = {
		scroller: $('scroller'), rows: $('rows'), spacer: $('spacer'), divider: $('divider'),
		filter: $('filter'), filterCount: $('filter-count'), banner: $('banner'), status: $('status'),
	};

	// Browsers cap element heights (~33M px in Chromium). Above this the scroll range is scaled.
	const MAX_SCROLL_PX = 8e6;
	const INDENT = 16;
	const MAX_DISPLAY = 2000; // chars of a value rendered in a row

	let text = null, version = -1, tree = null;
	let config = { indent: '\t', eol: '\n', keyColumnWidth: 260 };
	let collapsed = new Uint8Array(0);
	let vis = new Int32Array(0), visCount = 0;   // visible rows -> node index
	let mask = null, matchCount = 0, query = '';  // filter: mask[i] & 1 = visible, & 2 = match
	let selected = -1;
	let rowH = 22;
	let editing = null;   // { node, field, input, original, start, end }
	let pending = null;   // what to select / edit after our own edit comes back
	let remapQueue = [];  // shifts since the last parse, or 'index' after a full replacement
	let parseTimer = 0;
	let parseMs = 0;

	const state = vscode.getState() || {};

	// ---- Tree helpers ------------------------------------------------------------------------

	const isContainer = (i) => tree.type[i] <= NT.ARRAY;
	const startOf = (t, i) => (t.keyStart[i] >= 0 ? t.keyStart[i] : t.valStart[i]);
	const rootHidden = () => tree.count > 0 && tree.type[0] <= NT.ARRAY;

	/** Last node whose start offset is <= off (node starts are strictly increasing in preorder). */
	function nodeAtOrBefore(t, off) {
		let lo = 0, hi = t.count - 1, res = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			if (startOf(t, mid) <= off) { res = mid; lo = mid + 1; } else hi = mid - 1;
		}
		return res;
	}

	function depthOf(i) {
		let d = 0;
		for (let p = tree.parent[i]; p >= 0; p = tree.parent[p]) d++;
		return d;
	}

	function decodeString(s, e) {
		const long = e - s > MAX_DISPLAY;
		const raw = long ? text.slice(s, s + MAX_DISPLAY) + '"' : text.slice(s, e);
		let str;
		try { str = JSON.parse(raw); } catch { str = raw.slice(1, -1); }
		return long ? str + '…' : str;
	}

	function keyOf(i) {
		return tree.keyStart[i] >= 0 ? decodeString(tree.keyStart[i], tree.keyEnd[i]) : null;
	}

	function lastChild(c) {
		let last = -1;
		for (let j = c + 1; j < tree.subEnd[c]; j = tree.subEnd[j]) last = j;
		return last;
	}

	function prevSibling(i) {
		const p = tree.parent[i];
		let prev = -1;
		for (let j = p + 1; j < i; j = tree.subEnd[j]) prev = j;
		return prev;
	}

	/** Indentation of the line `off` is on, if only whitespace precedes `off` on that line; else null. */
	function lineIndent(off) {
		let i = off - 1;
		while (i >= 0) {
			const c = text.charCodeAt(i);
			if (c === 32 || c === 9) i--;
			else if (c === 10 || c === 13) break;
			else return null;
		}
		return text.slice(i + 1, off);
	}

	// ---- Parsing & state restoration ---------------------------------------------------------

	function scheduleParse() {
		if (!parseTimer) parseTimer = setTimeout(reparse, 0);
	}

	/** Makes sure the tree matches the text before acting on user input. */
	function flush() {
		if (parseTimer) { clearTimeout(parseTimer); reparse(); }
	}

	function reparse() {
		parseTimer = 0;
		const old = tree, oldCollapsed = collapsed, oldSelected = selected;
		const t0 = performance.now();
		tree = J.parse(text);
		parseMs = performance.now() - t0;
		const n = tree.count;

		// Carry collapse state and selection over to the new tree.
		collapsed = new Uint8Array(n);
		selected = -1;
		if (old && remapQueue === 'index') {
			// Full replacement (prettify, uglify, external change): same structure => same preorder indices.
			if (old.count === n) { collapsed = oldCollapsed; selected = oldSelected; }
		} else if (old) {
			const shift = (s) => {
				for (const q of remapQueue) {
					if (s < q.offset) continue;
					if (s >= q.offset + q.removed) s += q.inserted - q.removed;
					else if (s !== q.offset) return -1;
				}
				return s;
			};
			const starts = [];
			for (let i = 0; i < old.count; i++) {
				if (oldCollapsed[i]) { const s = shift(old.valStart[i]); if (s >= 0) starts.push(s); }
			}
			for (let i = 0, k = 0; i < n && k < starts.length; i++) {
				if (tree.type[i] > NT.ARRAY) continue;
				const s = tree.valStart[i];
				while (k < starts.length && starts[k] < s) k++;
				if (starts[k] === s) collapsed[i] = 1;
			}
			if (oldSelected >= 0 && oldSelected < old.count) {
				let s = shift(startOf(old, oldSelected));
				if (s < 0) s = remapQueue.length ? remapQueue[0].offset : 0;
				selected = nodeAtOrBefore(tree, s);
			}
		}
		remapQueue = [];

		if (pending && pending.offset !== undefined) {
			const i = nodeAtOrBefore(tree, pending.offset);
			if (i >= 0 && startOf(tree, i) === pending.offset) {
				selected = i;
				for (let p = tree.parent[i]; p >= 0; p = tree.parent[p]) collapsed[p] = 0;
			}
		}
		if (selected >= 0) selected = visibleAncestor(selected);
		if (query) computeFilter(pending && pending.offset !== undefined ? selected : -1);
		rebuild();
		if (pending && pending.row !== undefined && visCount) selected = vis[Math.min(pending.row, visCount - 1)];
		renderBanner();
		updateStatus();
		render();

		const p = pending;
		pending = null;
		if (p && p.edit && selected >= 0) startEdit(selected, p.field);
		else if (p && selected >= 0) ensureVisible(rowOf(selected));
	}

	/** Topmost collapsed ancestor of i (the row that shows i), or i itself. */
	function visibleAncestor(i) {
		let res = i;
		const stop = rootHidden() ? 0 : -1;
		for (let p = tree.parent[i]; p > stop; p = tree.parent[p]) if (collapsed[p]) res = p;
		return res === 0 && rootHidden() ? -1 : res;
	}

	// ---- Filter ------------------------------------------------------------------------------

	function computeFilter(keep) {
		const t = tree, n = t.count;
		mask = new Uint8Array(n);
		matchCount = 0;
		const ks = t.keyStart, ke = t.keyEnd, vs = t.valStart, ve = t.valEnd, ty = t.type, par = t.parent;
		const mark = (i) => {
			mask[i] |= 2;
			for (let p = par[i]; p >= 0 && !(mask[p] & 1); p = par[p]) mask[p] |= 1;
			mask[i] |= 1;
		};
		// Search the raw text once and map hits to nodes by offset (much faster than per-node substrings).
		const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
		let m;
		while ((m = re.exec(text)) !== null) {
			const s = m.index, e = s + m[0].length;
			const i = nodeAtOrBefore(t, s);
			if (i < 0) continue;
			let hit = ks[i] >= 0 && s > ks[i] && e < ke[i];
			if (!hit && ty[i] > NT.ARRAY) {
				const str = ty[i] === NT.STRING ? 1 : 0;
				hit = s >= vs[i] + str && e <= ve[i] - str;
			}
			if (!hit) continue;
			if (!(mask[i] & 2)) { matchCount++; mark(i); }
			const skip = ty[i] > NT.ARRAY ? ve[i] : ke[i];
			if (skip > re.lastIndex) re.lastIndex = skip;
		}
		if (keep >= 0) mark(keep); // node that is being added/edited stays visible
	}

	let filterTimer = 0;
	function onFilterInput() {
		clearTimeout(filterTimer);
		filterTimer = setTimeout(applyFilter, text && text.length > 4e6 ? 300 : 120);
	}

	function applyFilter() {
		flush();
		if (!tree) return;
		query = el.filter.value;
		if (query) computeFilter(-1); else { mask = null; matchCount = 0; }
		rebuild();
		setFirstExact(0);
		updateFilterCount();
		render();
	}

	function updateFilterCount() {
		el.filterCount.textContent = !query ? '' : matchCount ? `${matchCount.toLocaleString()} match${matchCount === 1 ? '' : 'es'}` : 'No matches';
	}

	// ---- Visible rows & virtual scrolling ----------------------------------------------------

	function rebuild() {
		const t = tree, n = t.count, sub = t.subEnd;
		if (vis.length < n) vis = new Int32Array(n);
		let c = 0, i = rootHidden() ? 1 : 0, openUntil = -1;
		while (i < n) {
			if (mask && i >= openUntil) {
				if (!mask[i]) { i = sub[i]; continue; }
				if (mask[i] & 2) openUntil = sub[i]; // a matching container shows its whole subtree
			}
			vis[c++] = i;
			i = collapsed[i] ? sub[i] : i + 1;
		}
		visCount = c;
		el.spacer.style.height = Math.max(0, Math.min(visCount * rowH, MAX_SCROLL_PX) - el.scroller.clientHeight) + 'px';
	}

	function metrics() {
		const viewH = el.scroller.clientHeight;
		const maxTop = Math.max(0, Math.min(visCount * rowH, MAX_SCROLL_PX) - viewH);
		const maxFirst = Math.max(0, visCount - viewH / rowH);
		return { viewH, maxTop, maxFirst };
	}

	/** Fractional index of the row at the top of the viewport. Linear in scrollTop, also when scaled. */
	function firstExact() {
		const { maxTop, maxFirst } = metrics();
		return maxTop > 0 ? Math.min(el.scroller.scrollTop, maxTop) / maxTop * maxFirst : 0;
	}

	function setFirstExact(fe) {
		const { maxTop, maxFirst } = metrics();
		el.scroller.scrollTop = maxFirst > 0 ? Math.max(0, Math.min(fe, maxFirst)) / maxFirst * maxTop : 0;
	}

	function rowOf(i) {
		return i < 0 ? -1 : vis.subarray(0, visCount).indexOf(i);
	}

	function ensureVisible(r) {
		if (r < 0) return render();
		const fe = firstExact(), inView = Math.max(1, Math.floor(el.scroller.clientHeight / rowH));
		if (r < fe) setFirstExact(r);
		else if (r > fe + inView - 1) setFirstExact(r - inView + 1);
		render();
	}

	function render() {
		if (!tree || editing) return;
		if (!visCount) {
			el.rows.innerHTML = `<div class="empty">${tree.count === 0 ? 'Empty document' :
				query ? 'No matches' :
				`Empty ${tree.type[0] === NT.OBJECT ? 'object' : 'array'} — press ${isMac ? '⌘' : 'Ctrl'}+Enter to add an entry`}</div>`;
			el.rows.style.transform = '';
			return;
		}
		const fe = firstExact(), first = Math.floor(fe);
		const end = Math.min(visCount, first + Math.ceil(el.scroller.clientHeight / rowH) + 2);
		let html = '';
		for (let r = first; r < end; r++) html += rowHtml(vis[r]);
		el.rows.innerHTML = html;
		el.rows.style.transform = `translateY(${-Math.round((fe - first) * rowH)}px)`;
	}

	let renderQueued = false;
	function queueRender() {
		if (renderQueued) return;
		renderQueued = true;
		requestAnimationFrame(() => { renderQueued = false; render(); });
	}

	// ---- Row markup --------------------------------------------------------------------------

	const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
	const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

	/** Escapes and wraps filter matches in <mark>. */
	function hl(s) {
		if (!query) return esc(s);
		const lower = s.toLowerCase(), q = query.toLowerCase();
		if (lower.length !== s.length) return esc(s);
		let out = '', from = 0, at;
		while ((at = lower.indexOf(q, from)) >= 0) {
			out += esc(s.slice(from, at)) + '<mark>' + esc(s.slice(at, at + q.length)) + '</mark>';
			from = at + q.length;
		}
		return out + esc(s.slice(from));
	}

	const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
	const oneLine = (s) => s.replace(/\r\n|\r|\n/g, '↵');

	function rowHtml(i) {
		const t = tree, ty = t.type[i], p = t.parent[i];
		const depth = depthOf(i) - (rootHidden() ? 1 : 0);
		const cont = ty <= NT.ARRAY;

		let keyHtml = '';
		if (t.keyStart[i] >= 0) keyHtml = `<span class="key" data-f="key">${hl(oneLine(keyOf(i)))}</span><span class="colon">:</span>`;
		else if (p >= 0) keyHtml = `<span class="key idx">${t.idx[i]}</span><span class="colon">:</span>`;

		let cls, val, title = '';
		if (cont) {
			const n = t.childCount[i], obj = ty === NT.OBJECT;
			cls = 'v-sum';
			val = esc((collapsed[i] ? (obj ? '{…}  ' : '[…]  ') : '') + (obj ? plural(n, 'key', 'keys') : plural(n, 'item', 'items')));
		} else {
			const s = t.valStart[i], e = t.valEnd[i];
			if (ty === NT.STRING) {
				cls = 'v-str';
				const str = oneLine(decodeString(s, e));
				const m = /^https?:\/\/\S+/i.exec(str);
				val = m ? `<span class="link" data-url="${esc(m[0])}" title="${isMac ? '⌘' : 'Ctrl'}+click to open">${hl(m[0])}</span>${hl(str.slice(m[0].length))}` : hl(str);
				if (str.length > 60 && !m) title = ` title="${esc(str.slice(0, 1000))}"`;
			} else {
				cls = ty === NT.NUMBER ? 'v-num' : ty === NT.BOOLEAN ? 'v-bool' : 'v-null';
				val = hl(text.slice(s, Math.min(e, s + MAX_DISPLAY)));
			}
		}
		const ctx = `{"webviewSection":"jsonNode","preventDefaultContextMenuItems":true,"node":${i},"version":${version},"jsonKind":"${cont ? 'container' : 'value'}","jsonHasKey":${t.keyStart[i] >= 0},"jsonIsRoot":${p < 0}}`;
		const pad = depth * INDENT;
		return `<div class="row${i === selected ? ' sel' : ''}" data-i="${i}" data-vscode-context='${ctx}'>` +
			`<span class="k" style="padding-left:${pad}px;min-width:${pad + 56}px"><span class="tw${cont && t.childCount[i] ? (collapsed[i] ? ' c' : ' o') : ''}"></span>${keyHtml}</span>` +
			`<span class="v ${cls}" data-f="value"${title}>${val}</span></div>`;
	}

	// ---- Banner & status ---------------------------------------------------------------------

	function renderBanner() {
		if (tree.error) {
			const pos = J.positionAt(text, tree.error.offset);
			el.banner.textContent = `⚠ ${tree.error.message} at line ${pos.line + 1}, column ${pos.character + 1} — only the part before the error is shown. Click to open as text.`;
			el.banner.hidden = false;
		} else el.banner.hidden = true;
	}

	function fmtSize(n) {
		return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
	}

	function updateStatus(msg) {
		el.status.textContent = msg || `${plural(tree.count, 'node', 'nodes')} · ${fmtSize(text.length)} · parsed in ${parseMs.toFixed(0)} ms`;
	}

	let statusTimer = 0;
	function flash(msg) {
		updateStatus(msg);
		clearTimeout(statusTimer);
		statusTimer = setTimeout(() => tree && updateStatus(), 4000);
	}

	// ---- Collapse / expand -------------------------------------------------------------------

	/** Re-lays out rows while keeping the top row in place. */
	function relayout() {
		const fe = firstExact();
		rebuild();
		setFirstExact(fe);
		render();
	}

	function toggle(i, open) {
		if (!isContainer(i)) return;
		const v = open === undefined ? !collapsed[i] : !open;
		if (!!collapsed[i] === v) return;
		collapsed[i] = v ? 1 : 0;
		relayout();
	}

	function collapseAll() {
		flush();
		if (!tree) return;
		const ty = tree.type;
		for (let i = rootHidden() ? 1 : 0; i < tree.count; i++) collapsed[i] = ty[i] <= NT.ARRAY ? 1 : 0;
		if (selected >= 0) selected = visibleAncestor(selected);
		rebuild();
		setFirstExact(0);
		render();
		ensureVisible(rowOf(selected));
	}

	function expandAll() {
		flush();
		if (!tree) return;
		collapsed.fill(0);
		rebuild();
		render();
		ensureVisible(rowOf(selected));
	}

	// ---- Selection & keyboard ----------------------------------------------------------------

	function select(i, reveal = true) {
		selected = i;
		if (reveal) return ensureVisible(rowOf(i));
		// Update in place: replacing the row elements under the mouse would break double-click.
		for (const row of el.rows.children) row.classList.toggle('sel', +row.dataset.i === i);
	}

	function moveSel(delta) {
		if (!visCount) return;
		const r = rowOf(selected);
		const nr = r < 0 ? (delta > 0 ? 0 : visCount - 1) : Math.max(0, Math.min(visCount - 1, r + delta));
		select(vis[nr]);
	}

	const isMac = navigator.platform.toUpperCase().includes('MAC');

	function onTreeKey(e) {
		if (editing || e.target === el.filter) return;
		flush();
		if (!tree) return;
		const mod = isMac ? e.metaKey : e.ctrlKey;
		const i = selected;
		const page = Math.max(1, Math.floor(el.scroller.clientHeight / rowH) - 1);
		let handled = true;
		switch (e.key) {
			case 'ArrowDown': moveSel(1); break;
			case 'ArrowUp': moveSel(-1); break;
			case 'PageDown': moveSel(page); break;
			case 'PageUp': moveSel(-page); break;
			case 'Home': if (visCount) select(vis[0]); break;
			case 'End': if (visCount) select(vis[visCount - 1]); break;
			case 'ArrowRight':
				if (i < 0) moveSel(1);
				else if (isContainer(i) && collapsed[i]) toggle(i, true);
				else if (isContainer(i) && tree.childCount[i]) moveSel(1);
				break;
			case 'ArrowLeft':
				if (i < 0) break;
				if (isContainer(i) && !collapsed[i] && tree.childCount[i]) toggle(i, false);
				else if (tree.parent[i] > 0 || (tree.parent[i] === 0 && !rootHidden())) select(tree.parent[i]);
				break;
			case ' ':
				if (i >= 0) toggle(i);
				break;
			case 'Enter':
				if (mod) {
					if (e.shiftKey) { if (i >= 0 && isContainer(i)) addChild(i); }
					else if (i >= 0) addAfter(i);
					else if (rootHidden()) addChild(0);
				} else if (i >= 0) {
					if (isContainer(i)) toggle(i); else startEdit(i, 'value');
				}
				break;
			case 'F2':
				if (i >= 0) startEdit(i, tree.keyStart[i] >= 0 ? 'key' : 'value');
				break;
			case 'Delete':
				if (i >= 0) deleteNode(i);
				break;
			case 'Backspace':
				if (i >= 0 && mod) deleteNode(i); else handled = false;
				break;
			case 'c':
				if (mod && i >= 0 && !String(window.getSelection())) copyValue(i); else handled = false;
				break;
			default:
				handled = false;
		}
		if (handled) e.preventDefault();
	}

	// ---- Editing -----------------------------------------------------------------------------

	function sendEdit(start, end, newText, after) {
		if (start === end && newText === '') return;
		pending = after || null;
		vscode.postMessage({ type: 'edit', version, edits: [{ offset: start, length: end - start, text: newText }] });
	}

	function structuralAllowed() {
		if (!tree.error) return true;
		flash('Fix the syntax error first — adding and deleting is disabled while the document is invalid.');
		return false;
	}

	function startEdit(i, field) {
		flush();
		if (editing) commitEdit();
		const t = tree;
		if (i < 0 || i >= t.count) return;
		if (field === 'key' && t.keyStart[i] < 0) return;
		if (field === 'value' && isContainer(i)) return;
		selected = i;
		ensureVisible(rowOf(i));
		const row = el.rows.querySelector(`.row[data-i="${i}"]`);
		const cell = row && row.querySelector(`[data-f="${field}"]`);
		if (!cell) return;

		const start = field === 'key' ? t.keyStart[i] : t.valStart[i];
		const end = field === 'key' ? t.keyEnd[i] : t.valEnd[i];
		// Keys are edited as plain text; values as JSON (strings incl. quotes) so the type can be changed.
		let original;
		if (field === 'key') { try { original = JSON.parse(text.slice(start, end)); } catch { original = text.slice(start + 1, end - 1); } }
		else original = text.slice(start, end);

		const input = document.createElement('input');
		input.className = 'edit';
		input.value = original;
		input.spellcheck = false;
		input.title = field === 'key' ? 'Enter to apply, Esc to cancel' : 'Value as JSON (e.g. "text", 42, true, null, [1, 2]). Anything that is not valid JSON is stored as a string. Enter to apply, Esc to cancel.';
		cell.replaceWith(input);
		if (field === 'key') { const colon = row.querySelector('.colon'); if (colon) colon.remove(); }
		editing = { node: i, field, input, original, start, end, scrollTop: el.scroller.scrollTop };

		input.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') { e.preventDefault(); commitEdit(true); }
			else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
			else if (e.key === 'Tab' && field === 'key' && !isContainer(i)) {
				// Key -> value, like a form. If the key changed, continue once the edit has come back.
				e.preventDefault();
				commitEdit(true);
				if (pending) { pending.edit = true; pending.field = 'value'; }
				else startEdit(i, 'value');
			}
		});
		input.addEventListener('blur', () => { if (editing && editing.input === input) commitEdit(); });
		input.focus();
		if (field === 'value' && t.type[i] === NT.STRING) input.setSelectionRange(1, original.length - 1);
		else input.select();
	}

	function commitEdit(refocus) {
		const ed = editing;
		if (!ed) return;
		editing = null;
		const v = ed.input.value;
		let newText = null;
		if (ed.field === 'key') {
			if (v !== ed.original) newText = JSON.stringify(v);
		} else {
			const raw = v.trim();
			if (raw !== ed.original) {
				let valid = raw !== '';
				if (valid) { try { JSON.parse(raw); } catch { valid = false; } }
				newText = valid ? raw : JSON.stringify(v);
			}
		}
		if (refocus) el.scroller.focus();
		if (newText !== null) sendEdit(ed.start, ed.end, newText, { offset: startOf(tree, ed.node) });
		render();
	}

	function cancelEdit() {
		editing = null;
		el.scroller.focus();
		render();
	}

	function uniqueKey(obj) {
		const keys = new Set();
		for (let j = obj + 1; j < tree.subEnd[obj]; j = tree.subEnd[j]) keys.add(keyOf(j));
		let k = 'key', n = 1;
		while (keys.has(k)) k = 'key' + ++n;
		return k;
	}

	function newEntry(container) {
		return tree.type[container] === NT.OBJECT ? JSON.stringify(uniqueKey(container)) + ': null' : 'null';
	}

	function addAfter(i) {
		flush();
		const p = tree.parent[i];
		if (p < 0 || !structuralAllowed()) return;
		const entry = newEntry(p);
		const at = tree.valEnd[i], s = startOf(tree, i);
		const ind = lineIndent(s);
		const sep = ind !== null ? ',' + config.eol + ind : text.charCodeAt(s - 1) === 32 ? ', ' : ',';
		sendEdit(at, at, sep + entry, { offset: at + sep.length, edit: true, field: tree.type[p] === NT.OBJECT ? 'key' : 'value' });
	}

	function addChild(c) {
		flush();
		if (!isContainer(c) || !structuralAllowed()) return;
		toggle(c, true);
		if (tree.childCount[c] > 0) return addAfter(lastChild(c));
		const entry = newEntry(c);
		const open = tree.valStart[c] + 1, close = tree.valEnd[c] - 1;
		const blank = /^\s*$/.test(text.slice(open, close));
		const ind = lineIndent(startOf(tree, c));
		const lead = ind !== null ? config.eol + ind + (J.detectIndent(text) || config.indent) : '';
		const ins = lead + entry + (ind !== null ? config.eol + ind : '');
		sendEdit(open, blank ? close : open, ins, { offset: open + lead.length, edit: true, field: tree.type[c] === NT.OBJECT ? 'key' : 'value' });
	}

	/** Offset after `off` skipping whitespace and comments, and the token found there. */
	function skipTrivia(off) {
		const sc = new J.Scanner(text);
		sc.pos = off;
		let t;
		do t = sc.next(); while (t === J.Token.LINE_COMMENT || t === J.Token.BLOCK_COMMENT);
		return { t, start: sc.start, end: sc.end };
	}

	function deleteNode(i) {
		flush();
		const t = tree, p = t.parent[i];
		if (p < 0 || !structuralAllowed()) return;
		const row = rowOf(i);
		const next = t.subEnd[i] < t.subEnd[p] ? t.subEnd[i] : -1;
		if (next >= 0) {
			// Remove "entry," plus following whitespace (and a trailing comment on the comma's line).
			const comma = skipTrivia(t.valEnd[i]);
			let e = comma.t === J.Token.COMMA ? comma.end : startOf(t, next);
			while (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9) e++;
			if (text.startsWith('//', e)) { const nl = text.indexOf('\n', e); e = nl < 0 ? text.length : nl; }
			while (e < startOf(t, next) && /\s/.test(text[e])) e++;
			return sendEdit(startOf(t, i), e, '', { row });
		}
		const prev = prevSibling(i);
		if (prev < 0) return sendEdit(t.valStart[p] + 1, t.valEnd[p] - 1, '', { row }); // only child
		// Last entry: remove the comma after the previous sibling and this entry (with its line), keep comments.
		const comma = skipTrivia(t.valEnd[prev]);
		if (comma.t !== J.Token.COMMA) return;
		let cut = startOf(t, i);
		if (lineIndent(cut) !== null) {
			cut = text.lastIndexOf('\n', cut - 1);
			if (text.charCodeAt(cut - 1) === 13) cut--;
			if (cut < comma.end) cut = comma.end;
		}
		sendEdit(comma.start, t.valEnd[i], text.slice(comma.end, cut), { row });
	}

	// ---- Copy --------------------------------------------------------------------------------

	function copyValue(i) {
		const t = tree;
		let s = text.slice(t.valStart[i], t.valEnd[i]);
		if (t.type[i] === NT.STRING) { try { s = JSON.parse(s); } catch { /* raw */ } }
		vscode.postMessage({ type: 'copy', text: s, what: 'value' });
	}

	function copyPath(i) {
		const parts = [];
		for (let j = i; tree.parent[j] >= 0; j = tree.parent[j]) {
			const k = keyOf(j);
			parts.push(k === null ? `[${tree.idx[j]}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : `[${JSON.stringify(k)}]`);
		}
		const path = parts.reverse().join('').replace(/^\./, '');
		vscode.postMessage({ type: 'copy', text: path || '$', what: 'path' });
	}

	// ---- Messages ----------------------------------------------------------------------------

	function applyConfig() {
		const kw = state.keyColumnWidth || config.keyColumnWidth || 260;
		document.documentElement.style.setProperty('--kw', kw + 'px');
	}

	function runNodeCommand(name, i) {
		flush();
		if (!tree || i < 0 || i >= tree.count) return;
		selected = i;
		switch (name) {
			case 'editValue': startEdit(i, 'value'); break;
			case 'editKey': startEdit(i, 'key'); break;
			case 'addAfter': addAfter(i); break;
			case 'addChild': addChild(i); break;
			case 'delete': deleteNode(i); break;
			case 'copyValue': copyValue(i); break;
			case 'copyPath': copyPath(i); break;
		}
	}

	window.addEventListener('message', (ev) => {
		const m = ev.data;
		switch (m.type) {
			case 'init':
				config = m.config;
				applyConfig();
				text = m.text;
				version = m.version;
				remapQueue = tree ? 'index' : [];
				clearTimeout(parseTimer);
				parseTimer = 0;
				// Let the status text paint before a potentially long parse.
				updateStatus(`Parsing ${fmtSize(text.length)}…`);
				setTimeout(reparse, 16);
				break;
			case 'config':
				config = m.config;
				applyConfig();
				break;
			case 'change': {
				if (text === null || m.version <= version) return;
				if (m.version !== version + 1) { vscode.postMessage({ type: 'resync' }); return; }
				const full = m.offset === 0 && m.length === text.length;
				text = text.slice(0, m.offset) + m.text + text.slice(m.offset + m.length);
				version = m.version;
				if (full) remapQueue = 'index';
				else if (remapQueue !== 'index') remapQueue.push({ offset: m.offset, removed: m.length, inserted: m.text.length });
				if (editing) cancelEdit();
				scheduleParse();
				break;
			}
			case 'replace':
				if (text === null || m.version <= version) return;
				text = m.text;
				version = m.version;
				remapQueue = 'index';
				if (editing) cancelEdit();
				scheduleParse();
				break;
			case 'nodeCommand':
				if (m.version === version) runNodeCommand(m.name, m.node);
				break;
			case 'editRejected':
				pending = null;
				flash('The document changed in the meantime — edit discarded.');
				break;
		}
	});

	// ---- DOM events --------------------------------------------------------------------------

	const rowNode = (target) => {
		const row = target.closest && target.closest('.row');
		return row ? +row.dataset.i : -1;
	};

	el.rows.addEventListener('mousedown', (e) => {
		if (e.target.closest('input')) return;
		flush();
		const i = rowNode(e.target);
		if (i < 0) return;
		if (e.target.classList.contains('tw') && isContainer(i)) { e.preventDefault(); selected = i; toggle(i); el.scroller.focus(); return; }
		if (editing) commitEdit();
		select(i, false);
		el.scroller.focus({ preventScroll: true });
	});
	el.rows.addEventListener('click', (e) => {
		const link = e.target.closest('.link');
		if (link && (isMac ? e.metaKey : e.ctrlKey)) vscode.postMessage({ type: 'openUrl', url: link.dataset.url });
	});
	el.rows.addEventListener('dblclick', (e) => {
		if (e.target.closest('input')) return;
		const i = rowNode(e.target);
		if (i < 0) return;
		const f = e.target.closest('[data-f]');
		const field = f ? f.dataset.f : null;
		if (field === 'key') startEdit(i, 'key');
		else if (field === 'value' && !isContainer(i)) startEdit(i, 'value');
		else if (isContainer(i)) toggle(i);
	});
	el.rows.addEventListener('contextmenu', (e) => {
		const i = rowNode(e.target);
		if (i >= 0 && i !== selected) { if (editing) commitEdit(); select(i, false); }
	});

	el.scroller.addEventListener('scroll', () => {
		if (editing && Math.abs(el.scroller.scrollTop - editing.scrollTop) > 1) commitEdit();
		queueRender();
	});
	el.scroller.addEventListener('keydown', onTreeKey);

	document.addEventListener('keydown', (e) => {
		if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'f') {
			e.preventDefault();
			el.filter.focus();
			el.filter.select();
		}
	});

	el.filter.addEventListener('input', onFilterInput);
	el.filter.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') { el.filter.value = ''; applyFilter(); el.scroller.focus(); }
		else if (e.key === 'Enter' || e.key === 'ArrowDown') {
			e.preventDefault();
			clearTimeout(filterTimer);
			if (el.filter.value !== query) applyFilter();
			el.scroller.focus();
			if (visCount && rowOf(selected) < 0) select(vis[0]);
		}
	});

	$('btn-collapse').addEventListener('click', collapseAll);
	$('btn-expand').addEventListener('click', expandAll);
	$('btn-prettify').addEventListener('click', () => vscode.postMessage({ type: 'format', mode: 'prettify' }));
	$('btn-uglify').addEventListener('click', () => vscode.postMessage({ type: 'format', mode: 'uglify' }));
	$('btn-text').addEventListener('click', () => vscode.postMessage({ type: 'openText' }));
	el.banner.addEventListener('click', () => vscode.postMessage({ type: 'openText' }));

	// Key column resizing.
	el.divider.addEventListener('mousedown', (e) => {
		e.preventDefault();
		el.divider.classList.add('drag');
		const left = el.scroller.getBoundingClientRect().left;
		const move = (ev) => {
			state.keyColumnWidth = Math.round(Math.max(60, Math.min(window.innerWidth - 80, ev.clientX - left)));
			applyConfig();
		};
		const up = () => {
			el.divider.classList.remove('drag');
			window.removeEventListener('mousemove', move);
			window.removeEventListener('mouseup', up);
			vscode.setState(state);
		};
		window.addEventListener('mousemove', move);
		window.addEventListener('mouseup', up);
	});

	new ResizeObserver(() => {
		if (!tree) return;
		const fe = firstExact();
		rebuild();
		setFirstExact(fe);
		render();
	}).observe(el.scroller);

	// Row height follows the editor font size.
	const fontSize = parseFloat(getComputedStyle(el.rows).fontSize) || 13;
	rowH = Math.max(18, Math.round(fontSize * 1.65));
	document.documentElement.style.setProperty('--row-h', rowH + 'px');

	applyConfig();
	vscode.postMessage({ type: 'ready' });
})();
