'use strict';

// End-to-end smoke checks against a running archive:
//   - plaintext NDJSON commit (201) + ordered GET
//   - gzip NDJSON commit (201) + ordered GET
//   - stable structured failures (duplicate 409, tamper 422, missing 404)
// Exits 0 only when every check passes.

const crypto = require('crypto');
const zlib = require('zlib');

const BASE = process.argv[2] || process.env.API_BASE || 'http://127.0.0.1:8080';
const ZERO = '0'.repeat(64);

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) fail(`${what}: expected ${expected}, got ${actual}`);
}

function assert(cond, what) {
  if (!cond) fail(what);
}

function makeBatch(label, n) {
  const rows = [];
  let prevHash = ZERO;
  let finalHash = prevHash;
  for (let i = 0; i < n; i += 1) {
    const payloadBuf = Buffer.from(`${label}:spectrum:${i}:${crypto.randomBytes(6).toString('hex')}`);
    const hash = crypto.createHash('sha256')
      .update(Buffer.from(prevHash, 'hex'))
      .update(payloadBuf)
      .digest('hex');
    rows.push({
      sequence: i,
      payload: payloadBuf.toString('base64'),
      prevHash,
      hash,
    });
    prevHash = hash;
    finalHash = hash;
  }
  return { rows, ndjson: Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')), finalHash };
}

async function post(runId, body, finalHash, headers = {}) {
  const res = await fetch(`${BASE}/api/runs/${runId}`, {
    method: 'POST',
    body,
    headers: { 'x-final-hash': finalHash, ...headers },
  });
  return { status: res.status, body: await res.json() };
}

async function get(runId) {
  const res = await fetch(`${BASE}/api/runs/${runId}`);
  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log(`smoke target: ${BASE}`);

  // 1. plaintext round trip
  const plain = makeBatch('plain', 5);
  const p1 = await post('smoke-plain', plain.ndjson, plain.finalHash, {
    'content-type': 'application/x-ndjson',
  });
  assertEqual(p1.status, 201, 'plaintext POST status');
  assertEqual(p1.body.status, 'committed', 'plaintext POST body status');
  assertEqual(p1.body.count, 5, 'plaintext POST count');

  const g1 = await get('smoke-plain');
  assertEqual(g1.status, 200, 'plaintext GET status');
  assert(JSON.stringify(g1.body.rows) === JSON.stringify(plain.rows),
    'plaintext GET rows match submitted order');
  for (let i = 0; i < g1.body.rows.length; i += 1) {
    assertEqual(g1.body.rows[i].sequence, i, `plaintext row ${i} sequence`);
  }
  console.log('  ok: plaintext commit + ordered read');

  // 2. gzip round trip
  const gz = makeBatch('gzip', 7);
  const gzipped = zlib.gzipSync(gz.ndjson);
  const p2 = await post('smoke-gzip', gzipped, gz.finalHash, {
    'content-type': 'application/x-ndjson',
    'content-encoding': 'gzip',
  });
  assertEqual(p2.status, 201, 'gzip POST status');
  assertEqual(p2.body.count, 7, 'gzip POST count');

  const g2 = await get('smoke-gzip');
  assertEqual(g2.status, 200, 'gzip GET status');
  assert(JSON.stringify(g2.body.rows) === JSON.stringify(gz.rows),
    'gzip GET rows match submitted order');
  console.log('  ok: gzip commit + ordered read');

  // 3. duplicate runId is a stable structured conflict
  const dup = await post('smoke-plain', plain.ndjson, plain.finalHash);
  assertEqual(dup.status, 409, 'duplicate POST status');
  assertEqual(dup.body.error.code, 'RUN_ALREADY_EXISTS', 'duplicate error code');
  console.log('  ok: duplicate runId rejected with 409');

  // 4. chain tampering is rejected and leaves nothing queryable
  const evil = makeBatch('evil', 3);
  const rows = evil.ndjson.toString().split('\n').map(JSON.parse);
  const buf = Buffer.from(rows[1].payload, 'base64');
  buf[0] ^= 0x01;
  rows[1].payload = buf.toString('base64');
  const tampered = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'));
  const bad = await post('smoke-tampered', tampered, evil.finalHash);
  assertEqual(bad.status, 422, 'tampered POST status');
  assertEqual(bad.body.error.code, 'HASH_MISMATCH', 'tampered error code');
  const missing = await get('smoke-tampered');
  assertEqual(missing.status, 404, 'tampered batch must not be queryable');
  assertEqual(missing.body.error.code, 'RUN_NOT_FOUND', 'missing error code');
  console.log('  ok: tampered chain rejected with 422 and no data retained');

  // 5. truncated tail presented with the original final hash
  const truncRows = evil.ndjson.toString().split('\n').slice(0, 2);
  const trunc = await post('smoke-truncated', Buffer.from(truncRows.join('\n')), evil.finalHash);
  assertEqual(trunc.status, 422, 'truncated POST status');
  assertEqual(trunc.body.error.code, 'FINAL_HASH_MISMATCH', 'truncated error code');
  console.log('  ok: truncated batch rejected with 422 FINAL_HASH_MISMATCH');

  if (process.exitCode === 1) {
    console.error('SMOKE: one or more checks failed');
    process.exit(1);
  }
  console.log('ALL SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error(`SMOKE ERROR: ${err.stack || err.message}`);
  process.exit(1);
});
