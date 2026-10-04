'use strict';

// The audit admission worker: one thread whose only job is to admit batches
// of audit events to the canonical ledger, so the synchronous SQLite and
// signing work never runs on the thread that serves tool calls. See
// src/lib/audit-admission.js for the contract.
//
// It shares nothing with the parent but the ledger file and the environment;
// from the ledger's point of view it is another writer process, held to the
// same cross-process witness checks as every MCP broker.

const { parentPort, isMainThread } = require('node:worker_threads');

if (isMainThread || !parentPort) {
  throw new Error('audit-admission-worker.js runs only as a worker thread.');
}

const audit = require('./audit');

// Statuses cross the thread boundary by structured clone; error entries are
// already plain {sink, code, message} objects, but a JSON round trip keeps
// any future non-cloneable field from failing the whole reply.
function cloneable(value) {
  return JSON.parse(JSON.stringify(value));
}

parentPort.on('message', async message => {
  if (!message || typeof message !== 'object' || !Array.isArray(message.items)) return;
  if (message.kind === 'close') {
    try {
      await audit.close();
      parentPort.postMessage({ id: message.id, result: { closed: true } });
    } catch (error) { parentPort.postMessage({ id: message.id, error: { code: error.code || 'AUDIT_CLOSE_FAILED', message: error.message } }); }
    return;
  }
  let reply;
  try {
    reply = { id: message.id, statuses: cloneable(audit.recordBatch(message.items)) };
  } catch (error) {
    reply = {
      id: message.id,
      error: {
        code: error && typeof error.code === 'string' ? error.code : 'AUDIT_ADMISSION_FAILED',
        message: error && error.message ? String(error.message) : String(error)
      }
    };
  }
  parentPort.postMessage(reply);
});
