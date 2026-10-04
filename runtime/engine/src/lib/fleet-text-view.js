'use strict';
// One bounded, terminal-safe projection of the versioned read-only pages.
// The CLI uses this instead of re-reading private state.
const { safe } = require('./fleet-read-view');
const NAMES = new Set(['ledger', 'settings']);

function options({ width = 100, surface = 'plain' } = {}) {
  const size = Number(width);
  if (!Number.isSafeInteger(size) || size < 40 || size > 240) throw new Error('--width must be from 40 to 240.');
  if (!['console', 'plain'].includes(surface))
    throw new Error('Unknown Fleet text surface.');
  return { width: size, surface };
}
function line(value, width) {
  const clean = safe(value, 8192).replace(/[\r\n\t]/g, ' ');
  const chars = Array.from(clean);
  return chars.length <= width ? clean : chars.slice(0, width - 1).join('') + '…';
}
function rowText(name, row) {
  if (name === 'ledger') return `${row.id}  ${row.status}  ${row.title}`;
  if (name === 'settings') return `${row.id} = ${row.valueText}  (${row.provenance?.source || 'unknown'})`;
  throw new Error('Unknown Fleet row type.');
}
// What to do for the rest of a long view. The plugin has no terminal paging
// command, so the plain hint points at the /ledger pane and ledger.read.
function nextCommand(name, page, surface) {
  if (page.nextOffset === null || page.nextOffset === undefined) return null;
  if (surface === 'console') return 'n for next page';
  const remaining = Number.isSafeInteger(page.total) && Number.isSafeInteger(page.nextOffset)
    ? Math.max(0, page.total - page.nextOffset) : 0;
  const count = remaining > 0 ? `${remaining} more not shown.` : 'More not shown.';
  return name === 'ledger'
    ? `${count} Type /ledger to see them all, or ask Claude to read them with Fleet's ledger.read tool.`
    : count;
}
function wrappedLines(text, width) {
  const words = safe(text, 8192).replace(/[\r\n\t]/g, ' ').split(' ').filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (Array.from(next).length <= width) current = next;
    else { if (current) lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.map(item => line(item, width));
}
function render(name, page, requested = {}) {
  if (!NAMES.has(name) || !page || page.schema !== `ai.toolsenabled/fleet-${name}/v1`)
    throw new Error('Fleet text needs the matching versioned page.');
  const { width, surface } = options(requested);
  const records = Array.isArray(page.records) ? page.records : [];
  const total = Number.isSafeInteger(page.total) ? page.total : 1;
  const offset = Number.isSafeInteger(page.offset) ? page.offset : 0;
  const count = records.length;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, page.limit || 20)));
  const current = Math.min(pages, Math.floor(offset / Math.max(1, page.limit || 20)) + 1);
  const title = `Fleet · ${name[0].toUpperCase()}${name.slice(1)} · ${count} shown of ${total} · page ${current}/${pages}`;
  const rows = records.map(row => rowText(name, row));
  const more = nextCommand(name, page, surface);
  const lines = [title, ...rows.length ? rows : ['Nothing in this view.'],
    `Snapshot ${page.revision === undefined ? 'unknown' : page.revision}`];
  return { title: line(title, width), text: [...lines.map(item => line(item, width)),
    ...(more ? wrappedLines(more, width) : [])].join('\n'), more };
}
module.exports = Object.freeze({ render, options });
