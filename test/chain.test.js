'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  ZERO_HASH,
  BatchError,
  buildRows,
  verifyBatch,
  isValidRunId,
} = require('../src/chain');

function line(sequence, payloadBuf, prevHash) {
  const payload = payloadBuf.toString('base64');
  const hash = crypto.createHash('sha256')
    .update(Buffer.from(prevHash, 'hex'))
    .update(payloadBuf)
    .digest('hex');
  return { obj: { sequence, payload, prevHash, hash }, hash };
}

function makeBatch(spec) {
  const payloads = spec ?? [Buffer.from('hello'), Buffer.from('world')];
  const lines = [];
  let prev = ZERO_HASH;
  let lastHash = prev;
  for (let i = 0; i < payloads.length; i += 1) {
    const { obj, hash } = line(i, payloads[i], prev);
    lines.push(obj);
    prev = hash;
    lastHash = hash;
  }
  const ndjson = Buffer.from(lines.map((o) => JSON.stringify(o)).join('\n'));
  return { ndjson, lastHash, lines };
}

function expectError(fn, status, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof BatchError, `expected BatchError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

test('accepts a valid single-line batch with zero prevHash', () => {
  const { ndjson, lastHash } = makeBatch([Buffer.from('only line')]);
  const result = verifyBatch(ndjson, lastHash);
  assert.equal(result.count, 1);
  assert.equal(result.rows[0].prevHash, ZERO_HASH);
  assert.equal(result.rows[0].payload, Buffer.from('only line').toString('base64'));
});

test('accepts a chained multi-line batch', () => {
  const payloads = Array.from({ length: 500 }, (_, i) => Buffer.from(`scan-${i}`));
  const { ndjson, lastHash } = makeBatch(payloads);
  const result = verifyBatch(ndjson, lastHash);
  assert.equal(result.count, 500);
  for (let i = 1; i < 500; i += 1) {
    assert.equal(result.rows[i].prevHash, result.rows[i - 1].hash);
    assert.equal(result.rows[i].sequence, i);
  }
});

test('accepts empty payload bytes', () => {
  const { ndjson, lastHash } = makeBatch([Buffer.alloc(0)]);
  const result = verifyBatch(ndjson, lastHash);
  assert.equal(result.rows[0].payload, '');
});

test('rejects empty batch', () => {
  expectError(() => buildRows(Buffer.from('')), 400, 'EMPTY_BATCH');
  expectError(() => buildRows(Buffer.from('\n')), 400, 'EMPTY_BATCH');
});

test('rejects batch over 500 lines', () => {
  const { ndjson } = makeBatch(Array.from({ length: 501 }, (_, i) => Buffer.from([i % 256])));
  expectError(() => buildRows(ndjson), 413, 'BATCH_TOO_MANY_LINES');
});

test('enforces the 2 MiB decompressed boundary exactly', () => {
  const { ndjson, lastHash } = makeBatch([Buffer.from('x')]);
  const padTo = (size) => Buffer.concat([ndjson, Buffer.from(' '.repeat(size - ndjson.length))]);
  const atLimit = padTo(2 * 1024 * 1024);
  assert.equal(verifyBatch(atLimit, lastHash).count, 1);
  const over = padTo(2 * 1024 * 1024 + 1);
  expectError(() => verifyBatch(over, lastHash), 413, 'BATCH_TOO_LARGE');
});

test('rejects malformed JSON and non-object lines', () => {
  expectError(() => buildRows(Buffer.from('not json')), 400, 'INVALID_NDJSON');
  expectError(() => buildRows(Buffer.from('[1,2]')), 400, 'INVALID_LINE');
  expectError(() => buildRows(Buffer.from('null')), 400, 'INVALID_LINE');
});

test('rejects unexpected fields', () => {
  const { ndjson } = makeBatch();
  const lines = ndjson.toString().split('\n').map(JSON.parse);
  lines[0].extra = 1;
  const tampered = Buffer.from(lines.map((o) => JSON.stringify(o)).join('\n'));
  expectError(() => buildRows(tampered), 400, 'INVALID_LINE');
});

test('rejects non-contiguous or duplicate sequence', () => {
  const { ndjson } = makeBatch();
  const lines = ndjson.toString().split('\n').map(JSON.parse);
  lines[1].sequence = 2;
  const reordered = Buffer.from(lines.map((o) => JSON.stringify(o)).join('\n'));
  expectError(() => buildRows(reordered), 400, 'SEQUENCE_MISMATCH');

  const { ndjson: b2 } = makeBatch();
  const lines2 = b2.toString().split('\n').map(JSON.parse);
  lines2[1].sequence = 0;
  expectError(() => buildRows(Buffer.from(lines2.map((o) => JSON.stringify(o)).join('\n'))),
    400, 'SEQUENCE_MISMATCH');
});

test('rejects first line whose prevHash is not 64 zeros', () => {
  const { obj } = line(0, Buffer.from('a'), '1'.repeat(64));
  expectError(() => buildRows(Buffer.from(JSON.stringify(obj))), 422, 'PREV_HASH_MISMATCH');
});

test('rejects broken chain link (truncated/re-sent tail)', () => {
  const { ndjson } = makeBatch([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]);
  const lines = ndjson.toString().split('\n').map(JSON.parse);
  // Simulate a truncated tail resent with a zeroed link.
  lines[1].prevHash = ZERO_HASH;
  const broken = Buffer.from(lines.map((o) => JSON.stringify(o)).join('\n'));
  expectError(() => buildRows(broken), 422, 'PREV_HASH_MISMATCH');
});

test('rejects tampered payload via hash mismatch', () => {
  const { ndjson } = makeBatch([Buffer.from('secret')]);
  const obj = JSON.parse(ndjson.toString());
  obj.payload = Buffer.from('tamper').toString('base64');
  expectError(() => buildRows(Buffer.from(JSON.stringify(obj))), 422, 'HASH_MISMATCH');
});

test('rejects non-canonical Base64', () => {
  const { obj } = line(0, Buffer.from('ab'), ZERO_HASH);
  obj.payload = obj.payload.replace(/=+$/, ''); // strip padding
  expectError(() => buildRows(Buffer.from(JSON.stringify(obj))), 400, 'PAYLOAD_NOT_BASE64');
});

test('rejects uppercase hash formatting', () => {
  const { ndjson, lastHash } = makeBatch();
  const obj = JSON.parse(ndjson.toString().split('\n')[0]);
  obj.hash = obj.hash.toUpperCase();
  expectError(() => buildRows(Buffer.from(JSON.stringify(obj))), 400, 'INVALID_FIELD');
  expectError(() => verifyBatch(ndjson, lastHash.toUpperCase()), 400, 'FINAL_HASH_INVALID');
});

test('rejects X-Final-Hash unequal to last line hash (truncated batch)', () => {
  // Full two-line batch claimed with the hash of only the first line.
  const full = makeBatch([Buffer.from('a'), Buffer.from('b')]);
  const firstOnly = makeBatch([Buffer.from('a')]);
  expectError(() => verifyBatch(full.ndjson, firstOnly.lastHash), 422, 'FINAL_HASH_MISMATCH');
  // Truncated body (first line only) claimed with the original full final hash.
  expectError(() => verifyBatch(firstOnly.ndjson, full.lastHash), 422, 'FINAL_HASH_MISMATCH');
});

test('rejects missing X-Final-Hash', () => {
  const { ndjson } = makeBatch();
  expectError(() => verifyBatch(ndjson, undefined), 400, 'FINAL_HASH_INVALID');
});

test('runId validation', () => {
  assert.ok(isValidRunId('run_2026-10-05-A'));
  assert.ok(isValidRunId('0'));
  assert.ok(!isValidRunId(''));
  assert.ok(!isValidRunId('a/b'));
  assert.ok(!isValidRunId('a b'));
  assert.ok(!isValidRunId('a.b'));
  assert.ok(!isValidRunId('x'.repeat(129)));
});
