'use strict';
// Worker thread entry: formats large documents off the extension host's main thread.
const { parentPort, workerData } = require('worker_threads');
const { run } = require('./formatCore');

parentPort.postMessage(run(workerData.mode, workerData.text, workerData.opts));
