'use strict';
// JSONC scanner, flat tree parser and formatters (prettify / uglify).
// Shared by the extension host (require) and the webview (<script>), so: no Node or DOM APIs in here.
//
// Performance notes:
// - Everything works on the raw source string with charCodeAt; tokens are never materialised as objects.
// - The tree is stored as a "struct of arrays" (typed arrays, one slot per node, preorder), which keeps
//   multi-million-node documents at a few dozen bytes per node and lets subtrees be skipped in O(1) via subEnd.
// - Formatters copy token text verbatim (numbers keep their exact precision, strings their escapes).
(function (root, factory) {
	const api = factory();
	if (typeof module === 'object' && module.exports) module.exports = api;
	else root.JSONC = api;
})(typeof self !== 'undefined' ? self : this, function () {

	// ---- Tokens -------------------------------------------------------------------------------

	const T_EOF = 0, T_LBRACE = 1, T_RBRACE = 2, T_LBRACK = 3, T_RBRACK = 4, T_COLON = 5, T_COMMA = 6,
		T_STRING = 7, T_NUMBER = 8, T_TRUE = 9, T_FALSE = 10, T_NULL = 11,
		T_LINE_COMMENT = 12, T_BLOCK_COMMENT = 13, T_UNKNOWN = 14;

	function isDigit(c) { return c >= 48 && c <= 57; }

	// Exact JSON number grammar on text[s, e).
	function isNumber(text, s, e) {
		let i = s;
		if (text.charCodeAt(i) === 45) i++;
		if (i >= e) return false;
		let c = text.charCodeAt(i);
		if (c === 48) i++;
		else if (c >= 49 && c <= 57) { i++; while (i < e && isDigit(text.charCodeAt(i))) i++; }
		else return false;
		if (i < e && text.charCodeAt(i) === 46) {
			i++;
			if (i >= e || !isDigit(text.charCodeAt(i))) return false;
			while (i < e && isDigit(text.charCodeAt(i))) i++;
		}
		if (i < e) {
			c = text.charCodeAt(i);
			if (c !== 101 && c !== 69) return false;
			i++;
			c = text.charCodeAt(i);
			if (c === 43 || c === 45) i++;
			if (i >= e || !isDigit(text.charCodeAt(i))) return false;
			while (i < e && isDigit(text.charCodeAt(i))) i++;
		}
		return i === e;
	}

	class Scanner {
		constructor(text) {
			this.text = text;
			this.n = text.length;
			this.pos = 0;
			this.start = 0;   // current token [start, end)
			this.end = 0;
			this.nl = false;  // a line break precedes the current token
			this.bad = null;  // error message if the current token is malformed
		}

		next() {
			const text = this.text, n = this.n;
			let p = this.pos, nl = false;
			while (p < n) {
				const c = text.charCodeAt(p);
				if (c === 32 || c === 9) p++;
				else if (c === 10 || c === 13) { nl = true; p++; }
				else if (c === 0xFEFF || c === 0xA0 || c === 0x2028 || c === 0x2029) p++;
				else break;
			}
			this.nl = nl;
			this.start = p;
			this.bad = null;
			if (p >= n) { this.end = this.pos = n; return T_EOF; }

			const c = text.charCodeAt(p);
			let t, e = p + 1;
			switch (c) {
				case 123: t = T_LBRACE; break;
				case 125: t = T_RBRACE; break;
				case 91: t = T_LBRACK; break;
				case 93: t = T_RBRACK; break;
				case 58: t = T_COLON; break;
				case 44: t = T_COMMA; break;
				case 34: {
					t = T_STRING;
					for (;;) {
						if (e >= n) { this.bad = 'Unterminated string'; break; }
						const d = text.charCodeAt(e);
						if (d === 34) { e++; break; }
						if (d === 92) e += 2;
						else if (d === 10 || d === 13) { this.bad = 'Unterminated string'; break; }
						else e++;
					}
					if (e > n) e = n;
					break;
				}
				case 47: {
					const d = text.charCodeAt(p + 1);
					if (d === 47) {
						t = T_LINE_COMMENT;
						e = text.indexOf('\n', p);
						if (e < 0) e = n;
						if (e > p && text.charCodeAt(e - 1) === 13) e--;
					} else if (d === 42) {
						t = T_BLOCK_COMMENT;
						e = text.indexOf('*/', p + 2);
						if (e < 0) { e = n; this.bad = 'Unterminated comment'; } else e += 2;
					} else {
						t = T_UNKNOWN;
						this.bad = 'Unexpected character';
					}
					break;
				}
				default: {
					while (e < n) {
						const d = text.charCodeAt(e);
						if ((d >= 48 && d <= 57) || (d >= 97 && d <= 122) || (d >= 65 && d <= 90) || d === 45 || d === 43 || d === 46 || d === 95) e++;
						else break;
					}
					const len = e - p;
					if (c === 45 || isDigit(c)) {
						t = T_NUMBER;
						if (!isNumber(text, p, e)) this.bad = 'Invalid number';
					} else if (len === 4 && text.startsWith('true', p)) t = T_TRUE;
					else if (len === 5 && text.startsWith('false', p)) t = T_FALSE;
					else if (len === 4 && text.startsWith('null', p)) t = T_NULL;
					else { t = T_UNKNOWN; this.bad = len > 1 ? 'Unexpected token' : 'Unexpected character'; }
				}
			}
			this.end = this.pos = e;
			return t;
		}
	}

	// ---- Tree parser --------------------------------------------------------------------------

	const N_OBJECT = 1, N_ARRAY = 2, N_STRING = 3, N_NUMBER = 4, N_BOOLEAN = 5, N_NULL = 6;

	const ST_VALUE = 0, ST_KEY = 1, ST_COLON = 2, ST_AFTER = 3, ST_DONE = 4;

	function grow(a, cap) { const b = new a.constructor(cap); b.set(a); return b; }

	/**
	 * Parses JSONC into flat preorder node tables. Tolerant: stops at the first syntax error, keeps what was
	 * parsed so far and closes all open containers at the error offset.
	 * With `nodes === false` only validates (no allocation).
	 *
	 * Per node i: type, parent (-1 = root), keyStart/keyEnd (incl. quotes, -1 if none), valStart/valEnd,
	 * subEnd (one past the last descendant), childCount, idx (position within parent).
	 */
	function parse(text, nodes) {
		const record = nodes !== false;
		const sc = new Scanner(text);
		let cap = record ? Math.max(256, (text.length >>> 4) | 0) : 0;
		let type = new Uint8Array(cap), parent = new Int32Array(cap), keyStart = new Int32Array(cap),
			keyEnd = new Int32Array(cap), valStart = new Int32Array(cap), valEnd = new Int32Array(cap),
			subEnd = new Int32Array(cap), childCount = new Int32Array(cap), idx = new Int32Array(cap);
		let count = 0;
		const stack = [];     // node indices (record) of open containers
		const kinds = [];     // N_OBJECT / N_ARRAY of open containers
		let state = ST_VALUE, canClose = false;  // canClose: right after '[' / '{' or a (trailing) comma
		let pendKeyS = -1, pendKeyE = -1;
		let error = null;

		function add(t, s, e) {
			if (count === cap) {
				cap *= 2;
				type = grow(type, cap); parent = grow(parent, cap); keyStart = grow(keyStart, cap); keyEnd = grow(keyEnd, cap);
				valStart = grow(valStart, cap); valEnd = grow(valEnd, cap); subEnd = grow(subEnd, cap);
				childCount = grow(childCount, cap); idx = grow(idx, cap);
			}
			const i = count++;
			const p = stack.length ? stack[stack.length - 1] : -1;
			type[i] = t; parent[i] = p; keyStart[i] = pendKeyS; keyEnd[i] = pendKeyE;
			valStart[i] = s; valEnd[i] = e; subEnd[i] = i + 1; childCount[i] = 0;
			idx[i] = p >= 0 ? childCount[p]++ : 0;
			pendKeyS = pendKeyE = -1;
			return i;
		}

		for (;;) {
			const t = sc.next();
			if (t === T_LINE_COMMENT || t === T_BLOCK_COMMENT) {
				if (sc.bad) { error = { offset: sc.start, message: sc.bad }; break; }
				continue;
			}
			if (t === T_EOF) break;
			if (sc.bad) { error = { offset: sc.start, message: sc.bad }; break; }
			const s = sc.start;

			if (state === ST_VALUE) {
				let nt = 0;
				switch (t) {
					case T_LBRACE: nt = N_OBJECT; break;
					case T_LBRACK: nt = N_ARRAY; break;
					case T_STRING: nt = N_STRING; break;
					case T_NUMBER: nt = N_NUMBER; break;
					case T_TRUE: case T_FALSE: nt = N_BOOLEAN; break;
					case T_NULL: nt = N_NULL; break;
				}
				if (nt === N_OBJECT || nt === N_ARRAY) {
					stack.push(record ? add(nt, s, s + 1) : 0);
					kinds.push(nt);
					state = nt === N_OBJECT ? ST_KEY : ST_VALUE;
					canClose = true;
					continue;
				}
				if (nt) {
					if (record) add(nt, s, sc.end);
					state = kinds.length ? ST_AFTER : ST_DONE;
					continue;
				}
				if (t === T_RBRACK && canClose && kinds[kinds.length - 1] === N_ARRAY) { /* close below */ }
				else { error = { offset: s, message: 'Value expected' }; break; }
			} else if (state === ST_KEY) {
				if (t === T_STRING) { pendKeyS = s; pendKeyE = sc.end; state = ST_COLON; continue; }
				if (t !== T_RBRACE || !canClose) { error = { offset: s, message: 'Property name expected' }; break; }
			} else if (state === ST_COLON) {
				if (t === T_COLON) { state = ST_VALUE; canClose = false; continue; }
				error = { offset: s, message: 'Colon expected' }; break;
			} else if (state === ST_AFTER) {
				if (t === T_COMMA) {
					state = kinds[kinds.length - 1] === N_OBJECT ? ST_KEY : ST_VALUE;
					canClose = true;
					continue;
				}
				if (t !== T_RBRACE && t !== T_RBRACK) { error = { offset: s, message: 'Comma expected' }; break; }
			} else {
				error = { offset: s, message: 'End of file expected' }; break;
			}

			// Closing bracket.
			const k = kinds[kinds.length - 1];
			if ((t === T_RBRACE) !== (k === N_OBJECT)) {
				error = { offset: s, message: k === N_OBJECT ? "Expected '}'" : "Expected ']'" }; break;
			}
			kinds.pop();
			const ci = stack.pop();
			if (record) { valEnd[ci] = sc.end; subEnd[ci] = count; }
			state = kinds.length ? ST_AFTER : ST_DONE;
			canClose = false;
		}

		if (!error && kinds.length) {
			error = { offset: text.length, message: kinds[kinds.length - 1] === N_OBJECT ? "Unexpected end of file, expected '}'" : "Unexpected end of file, expected ']'" };
		}
		if (!error && state === ST_COLON) error = { offset: text.length, message: 'Colon expected' };
		if (error && record) {
			while (stack.length) { const ci = stack.pop(); valEnd[ci] = error.offset; subEnd[ci] = count; }
		}
		return { count, type, parent, keyStart, keyEnd, valStart, valEnd, subEnd, childCount, idx, error };
	}

	function validate(text) { return parse(text, false).error; }

	// ---- Formatters ---------------------------------------------------------------------------

	// Output buffer that keeps memory flat for huge outputs (avoids deep cons-string trees).
	class Out {
		constructor() { this.parts = []; this.chunks = []; }
		push(s) { const p = this.parts; p.push(s); if (p.length >= 16384) { this.chunks.push(p.join('')); this.parts = []; } }
		toString() { this.chunks.push(this.parts.join('')); this.parts = []; return this.chunks.join(''); }
	}

	const P_NONE = 0, P_OPEN = 1, P_VALUE = 2, P_COMMA = 3, P_COLON = 4;

	// Tries to lay out the container that starts right after the scanner's current '[' / '{' on one line.
	// Only containers of primitives qualify (no nesting, no comments, no trailing comma).
	// Returns the single-line text (scanner advanced past the closing bracket) or null (scanner restored).
	function tryInline(sc, isObj, budget) {
		const text = sc.text, save = sc.pos, close = isObj ? T_RBRACE : T_RBRACK;
		let s = isObj ? '{' : '[', last = P_OPEN, empty = true;
		for (;;) {
			const t = sc.next();
			if (t === close && !sc.bad) {
				if (last === P_COMMA || last === P_COLON) break;
				s = empty ? (isObj ? '{}' : '[]') : s + (isObj ? ' }' : ']');
				if (s.length <= budget) return s;
				break;
			}
			if (sc.bad || s.length > budget) break;
			if (t === T_COMMA) { if (last !== P_VALUE) break; s += ','; last = P_COMMA; continue; }
			if (t === T_COLON) { if (!isObj || last !== P_NONE) break; s += ':'; last = P_COLON; continue; }
			if (t < T_STRING || t > T_NULL) break;
			const tok = text.slice(sc.start, sc.end);
			if (isObj) {
				if (last === P_OPEN || last === P_COMMA) {
					if (t !== T_STRING) break;
					s += ' ' + tok; last = P_NONE;  // P_NONE = "after key"
				} else if (last === P_COLON) { s += ' ' + tok; last = P_VALUE; }
				else break;
			} else {
				if (last === P_OPEN) s += tok;
				else if (last === P_COMMA) s += ' ' + tok;
				else break;
				last = P_VALUE;
			}
			empty = false;
		}
		sc.pos = save;
		return null;
	}

	/**
	 * Pretty-prints JSONC. Comments are kept (trailing comments stay on their line), token text is copied verbatim.
	 * Containers holding only primitives are kept on one line if they fit into `maxInlineWidth` columns.
	 * opts: { indent: '\t' | '  ' ..., tabSize, eol, maxInlineWidth (0 = never inline), inlineObjects }
	 */
	function prettify(text, opts) {
		opts = opts || {};
		const unit = opts.indent != null ? opts.indent : '\t';
		const unitW = unit === '\t' ? (opts.tabSize || 4) : unit.length;
		const eol = opts.eol || '\n';
		const maxW = opts.maxInlineWidth != null ? opts.maxInlineWidth : 80;
		const inlineObjects = opts.inlineObjects !== false;
		const sc = new Scanner(text), out = new Out();
		const indents = [''];
		let level = 0, col = 0, prev = P_NONE, forceNl = false, any = false;

		function newline(l) {
			while (indents.length <= l) indents.push(indents[indents.length - 1] + unit);
			out.push(eol + indents[l]);
			col = l * unitW;
		}
		function emit(s) { out.push(s); col += s.length; any = true; }
		// Whitespace before a value / key / opening bracket.
		function sep() {
			if (prev === P_COLON && !forceNl) emit(' ');
			else if (prev !== P_NONE || forceNl) newline(level);
			forceNl = false;
		}

		for (;;) {
			const t = sc.next();
			if (t === T_EOF) break;
			switch (t) {
				case T_LINE_COMMENT:
				case T_BLOCK_COMMENT: {
					const tok = text.slice(sc.start, sc.end), first = !any;
					if (first) emit(tok);
					else if (!sc.nl) emit(' ' + tok);
					else { newline(level); emit(tok); }
					if (t === T_LINE_COMMENT || sc.nl || first) forceNl = true;
					break;
				}
				case T_LBRACE:
				case T_LBRACK: {
					sep();
					const isObj = t === T_LBRACE;
					if (level > 0 && maxW > 0 && (!isObj || inlineObjects)) {
						const s = tryInline(sc, isObj, maxW - col - 1);
						if (s !== null) { emit(s); prev = P_VALUE; break; }
					}
					emit(isObj ? '{' : '[');
					level++;
					prev = P_OPEN;
					break;
				}
				case T_RBRACE:
				case T_RBRACK:
					if (level > 0) level--;
					if (prev !== P_OPEN || forceNl) newline(level);
					forceNl = false;
					emit(t === T_RBRACE ? '}' : ']');
					prev = P_VALUE;
					break;
				case T_COMMA:
				case T_COLON:
					if (forceNl) { newline(level); forceNl = false; }
					emit(t === T_COMMA ? ',' : ':');
					prev = t === T_COMMA ? P_COMMA : P_COLON;
					break;
				default:
					sep();
					emit(text.slice(sc.start, sc.end));
					prev = P_VALUE;
			}
		}
		if (any && /\r?\n[ \t]*$/.test(text.slice(-64))) out.push(eol);
		return out.toString();
	}

	/** Removes all whitespace, comments and trailing commas. */
	function uglify(text) {
		const sc = new Scanner(text), out = new Out();
		let pendingComma = false;
		for (;;) {
			const t = sc.next();
			if (t === T_EOF) break;
			if (t === T_LINE_COMMENT || t === T_BLOCK_COMMENT) continue;
			if (t === T_COMMA) {
				if (pendingComma) out.push(',');
				pendingComma = true;
				continue;
			}
			if (pendingComma && t !== T_RBRACE && t !== T_RBRACK) out.push(',');
			pendingComma = false;
			switch (t) {
				case T_LBRACE: out.push('{'); break;
				case T_RBRACE: out.push('}'); break;
				case T_LBRACK: out.push('['); break;
				case T_RBRACK: out.push(']'); break;
				case T_COLON: out.push(':'); break;
				default: out.push(text.slice(sc.start, sc.end));
			}
		}
		return out.toString();
	}

	// ---- Helpers ------------------------------------------------------------------------------

	/** 0-based line / column of an offset. */
	function positionAt(text, offset) {
		let line = 0, last = -1, i = -1;
		while ((i = text.indexOf('\n', i + 1)) >= 0 && i < offset) { line++; last = i; }
		return { line, character: offset - last - 1 };
	}

	/**
	 * Guesses the indentation unit from the first lines of a document ('\t', '  ', ...), or null if nothing
	 * is indented (e.g. minified). Only looks at the first 64 KB.
	 */
	function detectIndent(text) {
		const head = text.length > 65536 ? text.slice(0, 65536) : text;
		let tabs = 0, spaces = 0, minSpaces = Infinity;
		for (const m of head.matchAll(/\n([ \t]+)\S/g)) {
			if (m[1].charCodeAt(0) === 9) tabs++;
			else { spaces++; if (m[1].length < minSpaces) minSpaces = m[1].length; }
		}
		if (!tabs && !spaces) return null;
		return tabs >= spaces ? '\t' : ' '.repeat(Math.min(minSpaces, 8));
	}

	return {
		Scanner, parse, validate, prettify, uglify, positionAt, isNumber, detectIndent,
		Token: { EOF: T_EOF, LBRACE: T_LBRACE, RBRACE: T_RBRACE, LBRACK: T_LBRACK, RBRACK: T_RBRACK, COLON: T_COLON, COMMA: T_COMMA, STRING: T_STRING, NUMBER: T_NUMBER, TRUE: T_TRUE, FALSE: T_FALSE, NULL: T_NULL, LINE_COMMENT: T_LINE_COMMENT, BLOCK_COMMENT: T_BLOCK_COMMENT, UNKNOWN: T_UNKNOWN },
		NodeType: { OBJECT: N_OBJECT, ARRAY: N_ARRAY, STRING: N_STRING, NUMBER: N_NUMBER, BOOLEAN: N_BOOLEAN, NULL: N_NULL },
	};
});
