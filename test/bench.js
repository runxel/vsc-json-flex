'use strict';
// Benchmarks the core on generated large documents: `node test/bench.js [sizeMB]`
const J = require('../lib/jsonc');

const targetMB = Number(process.argv[2]) || 50;

function geojson(mb) {
	const parts = [];
	let size = 0, id = 0;
	while (size < mb * 1048576) {
		const coords = [];
		for (let k = 0; k < 50; k++) coords.push(`[${(385000 + Math.random() * 1000).toFixed(10)},${(5820000 + Math.random() * 1000).toFixed(9)}]`);
		const f = `{"type":"Feature","id":${id++},"properties":{"name":"feature ${id}","valid":${id % 2 === 0},"note":null},"geometry":{"type":"LineString","coordinates":[${coords.join(',')}]}}`;
		parts.push(f);
		size += f.length + 1;
	}
	return `{"type":"FeatureCollection","features":[${parts.join(',')}]}`;
}

function time(label, fn) {
	const t0 = process.hrtime.bigint();
	const r = fn();
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	console.log(`${label.padEnd(28)} ${ms.toFixed(0).padStart(6)} ms`);
	return r;
}

const min = time(`generate ~${targetMB} MB`, () => geojson(targetMB));
console.log(`size: ${(min.length / 1048576).toFixed(1)} MB`);

time('JSON.parse (reference)', () => JSON.parse(min));
time('validate', () => J.validate(min));
const tree = time('parse (tree tables)', () => J.parse(min));
console.log(`nodes: ${tree.count.toLocaleString()}`);
const pretty = time('prettify', () => J.prettify(min, { indent: '\t' }));
console.log(`pretty size: ${(pretty.length / 1048576).toFixed(1)} MB`);
time('parse prettified', () => J.parse(pretty));
const ugly = time('uglify prettified', () => J.uglify(pretty));
console.log(`round trip ok: ${ugly === min}`);
const re = /feature 1234/gi;
time('filter regex scan', () => { let n = 0; while (re.exec(pretty)) n++; return n; });
console.log(`heap used: ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);
