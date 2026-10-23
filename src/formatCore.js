'use strict';
// vscode-free part of formatting, usable from the extension host and from the worker thread.
const { validate, prettify, uglify } = require('../lib/jsonc');

/**
 * Validates and formats. The formatters are tolerant, so text is produced even if `error` is set;
 * the caller decides whether to use it.
 * @returns {{ text: string, error: { offset: number, message: string } | null }}
 */
function run(mode, text, opts) {
	const error = validate(text);
	return { error, text: mode === 'prettify' ? prettify(text, opts) : uglify(text) };
}

module.exports = { run };
