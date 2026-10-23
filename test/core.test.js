'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const J = require('../lib/jsonc');

const NT = J.NodeType;
const sample = fs.readFileSync(path.join(__dirname, 'test.json'), 'utf8');

/** Rebuilds a JS value from the flat node tables (checks offsets, structure and preorder layout). */
function materialize(text, t, i = 0) {
	const raw = text.slice(t.valStart[i], t.valEnd[i]);
	switch (t.type[i]) {
		case NT.OBJECT: {
			const o = {};
			for (let j = i + 1; j < t.subEnd[i]; j = t.subEnd[j]) o[JSON.parse(text.slice(t.keyStart[j], t.keyEnd[j]))] = materialize(text, t, j);
			return o;
		}
		case NT.ARRAY: {
			const a = [];
			for (let j = i + 1; j < t.subEnd[i]; j = t.subEnd[j]) { assert.strictEqual(t.idx[j], a.length); a.push(materialize(text, t, j)); }
			return a;
		}
		default: return JSON.parse(raw);
	}
}

const docs = {
	sample,
	nested: '{"a":[1,[2,[3,{"b":null}]]],"c":{"d":{"e":{}}},"f":[],"g":"x\\"y\\\\","h":-0.5e+10,"i":true,"j":false}',
	unicode: '{"japanese":"明日がある。","emoji":"😀","esc":"\\u00e9\\n\\t","<h1>":"thr<h1>ee"}',
	primitive: '  42  ',
	string: '"hello"',
};

test('parse matches JSON.parse', () => {
	for (const [name, text] of Object.entries(docs)) {
		const t = J.parse(text);
		assert.strictEqual(t.error, null, name);
		assert.deepStrictEqual(materialize(text, t), JSON.parse(text), name);
	}
});

test('parse records childCount, parent and subEnd', () => {
	const text = '{"a":[1,2,3],"b":{"c":true}}';
	const t = J.parse(text);
	assert.strictEqual(t.count, 7);
	assert.strictEqual(t.childCount[0], 2);
	assert.strictEqual(t.childCount[1], 3);
	assert.strictEqual(t.parent[2], 1);
	assert.strictEqual(t.subEnd[1], 5);
	assert.strictEqual(t.subEnd[0], 7);
	assert.strictEqual(text.slice(t.keyStart[5], t.keyEnd[5]), '"b"');
});

test('parse accepts JSONC (comments, trailing commas)', () => {
	const text = '// c\n{ /* x */ "a": 1, // y\n "b": [1, 2,], }\n/* end */';
	const t = J.parse(text);
	assert.strictEqual(t.error, null);
	assert.deepStrictEqual(materialize(text, t), { a: 1, b: [1, 2] });
});

test('parse reports errors and keeps a usable partial tree', () => {
	const cases = [
		['{"a" 1}', 'Colon expected', 5],
		['[1 2]', 'Comma expected', 3],
		['[1,2', "Unexpected end of file, expected ']'", 4],
		['{"a":1]', "Expected '}'", 6],
		['[1] 2', 'End of file expected', 4],
		['{a:1}', 'Unexpected character', 1],
		['{"a":1,} 2', 'End of file expected', 9],
		['[01]', 'Invalid number', 1],
		['["abc\n"]', 'Unterminated string', 1],
		['[NaN]', 'Unexpected token', 1],
		['[1,,2]', 'Value expected', 3],
	];
	for (const [text, message, offset] of cases) {
		const t = J.parse(text);
		assert.deepStrictEqual(t.error, { message, offset }, text);
		for (let i = 0; i < t.count; i++) assert.ok(t.subEnd[i] > i && t.subEnd[i] <= t.count, text);
	}
	assert.strictEqual(J.validate(''), null);
	assert.strictEqual(J.validate('  // only a comment\n'), null);
});

test('number grammar', () => {
	for (const ok of ['0', '-0', '1.5', '-1.5e10', '1E-2', '123456789012345678901234567890']) assert.ok(J.isNumber(ok, 0, ok.length), ok);
	for (const bad of ['01', '-', '1.', '.5', '1e', '1e+', '--1', '0x10', '+1']) assert.ok(!J.isNumber(bad, 0, bad.length), bad);
});

test('uglify removes whitespace, comments and trailing commas', () => {
	const text = '// c\n{\n\t"a": [1, 2, ], /* x */\n\t"b": "s p a c e",\n}\n';
	assert.strictEqual(J.uglify(text), '{"a":[1,2],"b":"s p a c e"}');
	for (const [name, t] of Object.entries(docs)) {
		const u = J.uglify(t);
		assert.ok(!/\s/.test(u.replace(/"(?:[^"\\]|\\.)*"/g, '')), name);
		assert.deepStrictEqual(JSON.parse(u), JSON.parse(t), name);
	}
	assert.strictEqual(J.uglify(sample), sample, 'sample is minified already');
});

test('formatters keep number and string tokens verbatim', () => {
	const text = '{"big":12345678901234567890123,"f":1.10,"e":1E5,"s":"\\u00e9\\/"}';
	assert.strictEqual(J.uglify(text), text);
	assert.ok(J.prettify(text).includes('12345678901234567890123'));
	assert.ok(J.prettify(text).includes('1.10'));
	assert.ok(J.prettify(text).includes('"\\u00e9\\/"'));
});

test('prettify layout', () => {
	const text = '{"a":1,"b":[1,2,3],"c":{"x":1,"y":"z"},"d":[],"e":{},"f":[{"g":[1,{"h":2}]}]}';
	assert.strictEqual(J.prettify(text, { indent: '  ' }), [
		'{',
		'  "a": 1,',
		'  "b": [1, 2, 3],',
		'  "c": { "x": 1, "y": "z" },',
		'  "d": [],',
		'  "e": {},',
		'  "f": [',
		'    {',
		'      "g": [',
		'        1,',
		'        { "h": 2 }',
		'      ]',
		'    }',
		'  ]',
		'}',
	].join('\n'));
	assert.strictEqual(J.prettify(text, { indent: '\t', maxInlineWidth: 0 }).split('\n').length, 24);
	assert.ok(J.prettify(text, { inlineObjects: false }).includes('"c": {\n'));
	assert.strictEqual(J.prettify('[1,2]'), '[\n\t1,\n\t2\n]', 'root is never inlined');
	assert.strictEqual(J.prettify('{}'), '{}');
	assert.strictEqual(J.prettify('{"a":1}', { eol: '\r\n' }), '{\r\n\t"a": 1\r\n}');
});

test('prettify respects maxInlineWidth including indentation and key', () => {
	const arr = '[' + Array.from({ length: 10 }, (_, i) => i * 1000).join(',') + ']';
	const inline = '"key": [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000],';
	const text = `{"key":${arr},"z":1}`;
	assert.ok(J.prettify(text, { indent: '\t', tabSize: 4, maxInlineWidth: 4 + inline.length }).includes(inline));
	assert.ok(!J.prettify(text, { indent: '\t', tabSize: 4, maxInlineWidth: 3 + inline.length }).includes(inline));
});

test('prettify keeps comments', () => {
	const text = '// header\n{"a":1, // trailing a\n/* own line */\n"b":[1,2], "c": /* inline */ 3}';
	assert.strictEqual(J.prettify(text), [
		'// header',
		'{',
		'\t"a": 1, // trailing a',
		'\t/* own line */',
		'\t"b": [1, 2],',
		'\t"c": /* inline */ 3',
		'}',
	].join('\n'));
	assert.strictEqual(J.validate(J.prettify(text)), null);
});

test('prettify is idempotent and round-trips through uglify', () => {
	for (const [name, t] of Object.entries(docs)) {
		const p = J.prettify(t);
		assert.strictEqual(J.prettify(p), p, name);
		assert.strictEqual(J.uglify(p), J.uglify(t), name);
		assert.deepStrictEqual(JSON.parse(p), JSON.parse(t), name);
	}
});

test('prettify keeps a final newline only if there was one', () => {
	assert.ok(J.prettify('{"a":1}\n').endsWith('}\n'));
	assert.ok(J.prettify('{"a":1}').endsWith('}'));
});

test('formatters do not lose content of invalid documents', () => {
	const text = '{"a": 1 "b": [1, 2}';
	assert.ok(J.validate(text));
	assert.strictEqual(J.uglify(J.prettify(text)), J.uglify(text));
});

test('deep nesting does not overflow the stack', () => {
	const depth = 100000;
	const text = '['.repeat(depth) + ']'.repeat(depth);
	const t = J.parse(text);
	assert.strictEqual(t.error, null);
	assert.strictEqual(t.count, depth);
	assert.strictEqual(J.uglify(text), text);
	// Prettified output grows quadratically with depth (indentation), so use a smaller one here.
	const p = J.prettify('['.repeat(2000) + ']'.repeat(2000), { indent: ' ' });
	assert.strictEqual(J.validate(p), null);
});

test('positionAt', () => {
	assert.deepStrictEqual(J.positionAt('ab\ncd\nef', 4), { line: 1, character: 1 });
	assert.deepStrictEqual(J.positionAt('ab', 0), { line: 0, character: 0 });
});

test('detectIndent', () => {
	assert.strictEqual(J.detectIndent('{\n\t"a": {\n\t\t"b": 1\n\t}\n}'), '\t');
	assert.strictEqual(J.detectIndent('{\n  "a": {\n    "b": 1\n  }\n}'), '  ');
	assert.strictEqual(J.detectIndent('{\r\n    "a": 1\r\n}'), '    ');
	assert.strictEqual(J.detectIndent('{"a":1}'), null);
});
