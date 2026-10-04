// Untrusted ledger text is rendered as plain text, never markup or an action.
export function cleanText(value, maximum = 16384) {
  if (typeof value !== 'string') throw new Error('Invalid ledger text');
  if (value.length > maximum) {
    let end = maximum - 1;
    // Do not leave half of an astral character before the truncation marker.
    if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    value = value.slice(0, end) + '…';
  }
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ch => ch === '\n' || ch === '\t' ? ch : '\ufffd');
}
const integer = n => Number.isSafeInteger(n) && n >= 0;
const date = value => {
  if (value === null) return null;
  const ms = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error('Invalid ledger timestamp');
  return new Date(ms).toISOString();
};
export function parsePage(value, query) {
  const fail = () => { throw new Error('Invalid ledger page'); };
  if (!value || value.schema !== 'ai.toolsenabled/fleet-ledger/v1' || value.grantsAuthority !== false
      || value.view !== (query.all ? 'all' : 'open') || value.offset !== query.offset || value.limit !== query.limit
      || !integer(value.total) || !Array.isArray(value.records) || value.records.length > query.limit
      || !(integer(value.revision) || value.revision === null && value.total === 0)
      || query.revision !== undefined && value.revision !== query.revision
      || value.records.length !== Math.min(query.limit, Math.max(0, value.total - query.offset))) fail();
  const end = value.offset + value.records.length;
  if (value.nextOffset !== (end < value.total ? end : null)) fail();
  const ids = new Set();
  const records = value.records.map(row => {
    if (!row || !['R', 'T', 'A'].includes(row.kind) || typeof row.id !== 'string' || row.id.length > 64
        || !/^[RTA][1-9]\d*(?:\.[1-9]\d*)*$/.test(row.id) || row.id[0] !== row.kind || ids.has(row.id)
        || !['global', 'session', 'tree', 'thread'].includes(row.scope)) fail();
    ids.add(row.id);
    return { id: row.id, kind: row.kind, title: cleanText(row.title, 200).replace(/\s+/g, ' '), words: cleanText(row.words),
      status: cleanText(row.status, 80).replace(/\s+/g, ' '), filedAt: date(row.filedAt),
      filedBy: row.filedBy === null ? '' : cleanText(row.filedBy, 80).replace(/\s+/g, ' '), scope: row.scope,
      scopeKey: row.scopeKey === null ? '' : cleanText(row.scopeKey, 128).replace(/\s+/g, ' '), completedAt: date(row.completedAt),
      answer: row.answer === null ? null : { words: cleanText(row.answer.words), at: date(row.answer.at) } };
  });
  return { records, revision: value.revision, total: value.total, offset: value.offset, nextOffset: value.nextOffset };
}
export function age(filedAt, now) {
  if (!filedAt) return 'unknown';
  const minutes = Math.max(0, Math.floor((now - Date.parse(filedAt)) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
