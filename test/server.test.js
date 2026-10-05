'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { ZERO_HASH } = require('../src/chain');
const { Storage } = require('../src/storage');
const { createApp } = require('../src/server');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-runs-'));

function makeBatch(numLines = 3) {
  const rows = [];
  let prev = ZERO_HASH;
  let lastHash = prev;
  for (let i = 0; i < numLines; i += 1) {
    const payloadBuf = Buffer.from(`spectrum-${i}-${crypto.randomBytes(4).toString('hex')}`);
    const hash = crypto.createHash('sha256')
      .update(Buffer.from(prev, 'hex')).update(payloadBuf).digest('hex');
    rows.push({ sequence: i, payload: payloadBuf.toString('base64'), prevHash: prev, hash });
    prev = hash;
    lastHash = hash;
  }
  return { ndjson: Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')), lastHash, rows };
}

function tamperAt(ndjson, lineIdx) {
  const rows = ndjson.toString().split('\n').map(JSON.parse);
  const buf = Buffer.from(rows[lineIdx].payload, 'base64');
  buf[0] ^= 0xff;
  rows[lineIdx].payload = buf.toString('base64');
  return Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'));
}

async function withServer(dataDir, fn) {
  const storage = new Storage(dataDir, { logger: { error() {}, warn() {}, log() {} } });
  await storage.init();
  const server = createApp(storage, { logger: { error() {}, warn() {}, log() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({ base, storage, dataDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function api(base, method, p, { body, headers = {} } = {}) {
  const res = await fetch(`${base}${p}`, { method, body, headers, duplex: 'half' });
  const json = await res.json();
  return { status: res.status, json, headers: res.headers };
}

before(() => {
  console.log(`test data dir: ${ROOT}`);
});
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('health endpoint responds ok', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'health-'));
  await withServer(dir, async ({ base }) => {
    const r = await api(base, 'GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
  });
});

test('201 on valid plaintext batch and GET returns ordered rows', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'plain-'));
  const batch = makeBatch(4);
  await withServer(dir, async ({ base }) => {
    const r = await api(base, 'POST', '/api/runs/run-plain-1', {
      body: batch.ndjson,
      headers: { 'content-type': 'application/x-ndjson', 'x-final-hash': batch.lastHash },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.count, 4);
    assert.equal(r.json.finalHash, batch.lastHash);
    assert.equal(r.headers.get('location'), '/api/runs/run-plain-1');

    const g = await api(base, 'GET', '/api/runs/run-plain-1');
    assert.equal(g.status, 200);
    assert.deepEqual(g.json.rows, batch.rows);
    assert.equal(g.json.status, 'committed');
  });
});

test('201 on valid gzip batch', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'gzip-'));
  const batch = makeBatch(5);
  await withServer(dir, async ({ base }) => {
    const gz = zlib.gzipSync(batch.ndjson);
    const r = await api(base, 'POST', '/api/runs/gz-1', {
      body: gz,
      headers: { 'content-encoding': 'gzip', 'x-final-hash': batch.lastHash },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const g = await api(base, 'GET', '/api/runs/gz-1');
    assert.deepEqual(g.json.rows, batch.rows);
  });
});

test('400 on corrupt gzip body and nothing is stored', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'badgz-'));
  await withServer(dir, async ({ base }) => {
    const r = await api(base, 'POST', '/api/runs/bad-gz', {
      body: Buffer.from([0x1f, 0x8b, 0x08, 0, 1, 2, 3, 255, 254]),
      headers: { 'content-encoding': 'gzip', 'x-final-hash': '0'.repeat(64) },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'INVALID_GZIP');
    const g = await api(base, 'GET', '/api/runs/bad-gz');
    assert.equal(g.status, 404);
    assert.equal(g.json.error.code, 'RUN_NOT_FOUND');
  });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => !n.startsWith('.tmp')), []);
});

test('422 on tampered payload and nothing is stored', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'tamper-'));
  const batch = makeBatch(3);
  const tampered = tamperAt(batch.ndjson, 1);
  await withServer(dir, async ({ base }) => {
    const r = await api(base, 'POST', '/api/runs/tamp-1', {
      body: tampered,
      headers: { 'x-final-hash': batch.lastHash },
    });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'HASH_MISMATCH');
    assert.equal(r.json.error.details.line, 2);
    assert.equal((await api(base, 'GET', '/api/runs/tamp-1')).status, 404);
  });
});

test('422 on truncated batch presented with the original final hash', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'trunc-'));
  const batch = makeBatch(5);
  const rows = batch.ndjson.toString().split('\n').slice(0, 2);
  const truncated = Buffer.from(rows.join('\n'));
  await withServer(dir, async ({ base }) => {
    const r = await api(base, 'POST', '/api/runs/trunc-1', {
      body: truncated,
      headers: { 'x-final-hash': batch.lastHash },
    });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'FINAL_HASH_MISMATCH');
    assert.equal((await api(base, 'GET', '/api/runs/trunc-1')).status, 404);
  });
});

test('409 on duplicate runId and the first batch stays authoritative', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'dup-'));
  const first = makeBatch(2);
  const second = makeBatch(3);
  await withServer(dir, async ({ base }) => {
    const r1 = await api(base, 'POST', '/api/runs/same-id', {
      body: first.ndjson, headers: { 'x-final-hash': first.lastHash },
    });
    assert.equal(r1.status, 201);

    const r2 = await api(base, 'POST', '/api/runs/same-id', {
      body: second.ndjson, headers: { 'x-final-hash': second.lastHash },
    });
    assert.equal(r2.status, 409);
    assert.equal(r2.json.error.code, 'RUN_ALREADY_EXISTS');

    const g = await api(base, 'GET', '/api/runs/same-id');
    assert.equal(g.json.count, 2);
    assert.deepEqual(g.json.rows, first.rows);
  });
});

test('concurrent posts with same runId: exactly one 201, rest 409', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'race-'));
  const batch = makeBatch(10);
  await withServer(dir, async ({ base }) => {
    const attempts = await Promise.all(Array.from({ length: 8 }, () =>
      api(base, 'POST', '/api/runs/raced', {
        body: batch.ndjson,
        headers: { 'x-final-hash': batch.lastHash,
          'content-type': 'application/x-ndjson' },
      })));
    const created = attempts.filter((a) => a.status === 201);
    const conflicts = attempts.filter((a) => a.status === 409);
    assert.equal(created.length, 1, `statuses: ${attempts.map((a) => a.status).join(',')}`);
    assert.equal(conflicts.length, 7);
    assert.equal(conflicts.every((a) => a.json.error.code === 'RUN_ALREADY_EXISTS'), true);

    const g = await api(base, 'GET', '/api/runs/raced');
    assert.equal(g.status, 200);
    assert.equal(g.json.count, 10);
  });
});

test('concurrent valid and invalid batches for one runId: exactly the valid one commits', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'race-mix-'));
  await withServer(dir, async ({ base }) => {
    // Interleave both orderings across separate run ids.
    for (const runId of ['mix-a', 'mix-b']) {
      const goodBatch = makeBatch(4);
      const badBatch = tamperAt(makeBatch(4).ndjson, 0);
      const tasks = runId === 'mix-a'
        ? [
            api(base, 'POST', `/api/runs/${runId}`, {
              body: goodBatch.ndjson, headers: { 'x-final-hash': goodBatch.lastHash } }),
            api(base, 'POST', `/api/runs/${runId}`, {
              body: badBatch, headers: { 'x-final-hash': '0'.repeat(64) } }),
          ]
        : [
            api(base, 'POST', `/api/runs/${runId}`, {
              body: badBatch, headers: { 'x-final-hash': '0'.repeat(64) } }),
            api(base, 'POST', `/api/runs/${runId}`, {
              body: goodBatch.ndjson, headers: { 'x-final-hash': goodBatch.lastHash } }),
          ];
      const results = await Promise.all(tasks);
      const created = results.filter((r) => r.status === 201);
      assert.equal(created.length, 1,
        `expected one 201 for ${runId}, got ${results.map((r) => r.status).join(',')}`);
      const g = await api(base, 'GET', `/api/runs/${runId}`);
      assert.equal(g.status, 200);
      assert.deepEqual(g.json.rows, goodBatch.rows);
    }
  });
});

test('committed run survives a container-style restart', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'restart-'));
  const batch = makeBatch(6);
  await withServer(dir, async ({ base }) => {
    const r = await api(base, 'POST', '/api/runs/persist-1', {
      body: batch.ndjson, headers: { 'x-final-hash': batch.lastHash },
    });
    assert.equal(r.status, 201);
  });

  await withServer(dir, async ({ base }) => {
    const g = await api(base, 'GET', '/api/runs/persist-1');
    assert.equal(g.status, 200);
    assert.deepEqual(g.json.rows, batch.rows);
    assert.equal(g.json.finalHash, batch.lastHash);
    // A duplicate is still rejected after restart.
    const r2 = await api(base, 'POST', '/api/runs/persist-1', {
      body: batch.ndjson, headers: { 'x-final-hash': batch.lastHash },
    });
    assert.equal(r2.status, 409);
  });
});

test('record tampered on disk is never served after restart', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'disk-tamper-'));
  const batch = makeBatch(2);
  await withServer(dir, async ({ base }) => {
    await api(base, 'POST', '/api/runs/disk-1', {
      body: batch.ndjson, headers: { 'x-final-hash': batch.lastHash },
    });
  });

  const file = path.join(dir, 'disk-1.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.rows[0].payload = Buffer.from('forged').toString('base64');
  fs.writeFileSync(file, JSON.stringify(record));

  await withServer(dir, async ({ base }) => {
    const g = await api(base, 'GET', '/api/runs/disk-1');
    assert.equal(g.status, 404);

    // Quarantining releases the runId: a valid re-send commits normally.
    const fresh = makeBatch(3);
    const r = await api(base, 'POST', '/api/runs/disk-1', {
      body: fresh.ndjson, headers: { 'x-final-hash': fresh.lastHash },
    });
    assert.equal(r.status, 201);
    const g2 = await api(base, 'GET', '/api/runs/disk-1');
    assert.deepEqual(g2.json.rows, fresh.rows);
  });

  const remaining = fs.readdirSync(dir);
  assert.ok(remaining.some((n) => n.startsWith('.quarantine-')),
    'tampered record should be kept under a quarantine name');
});

test('orphan temp files from a crash are swept and never served', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'orphan-'));
  fs.writeFileSync(path.join(dir, '.tmp-run-1-1-deadbeef'), 'partial garbage');
  await withServer(dir, async ({ base }) => {
    const g = await api(base, 'GET', '/api/runs/run-1');
    assert.equal(g.status, 404);
  });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('404 and 400 failures share a stable structured shape', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'shape-'));
  await withServer(dir, async ({ base }) => {
    const missing = await api(base, 'GET', '/api/runs/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'RUN_NOT_FOUND');
    assert.equal(typeof missing.json.error.message, 'string');
    assert.equal(missing.json.error.runId, 'nope');

    const badId = await api(base, 'GET', '/api/runs/bad%2Fid');
    assert.equal(badId.status, 400);
    assert.equal(badId.json.error.code, 'INVALID_RUN_ID');

    const noRoute = await api(base, 'GET', '/api/other');
    assert.equal(noRoute.status, 404);
    assert.equal(noRoute.json.error.code, 'NOT_FOUND');
  });
});

test('missing X-Final-Hash is a structured 400 and stores nothing', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'nofinal-'));
  const batch = makeBatch(1);
  await withServer(dir, async ({ base }) => {
    const r = await api(base, 'POST', '/api/runs/no-final', {
      body: batch.ndjson, headers: {},
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'FINAL_HASH_INVALID');
    assert.equal((await api(base, 'GET', '/api/runs/no-final')).status, 404);
  });
});
