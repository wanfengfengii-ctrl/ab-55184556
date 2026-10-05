'use strict';

const crypto = require('crypto');

// Hash-chain parsing / verification for NDJSON run batches.
//
// Line schema (NDJSON, one JSON object per line):
//   { "sequence": <int from 0>, "payload": "<base64>",
//     "prevHash": "<64 lowercase hex>", "hash": "<64 lowercase hex>" }
//
// hash_i = sha256( raw32(prevHash_i) || base64_decode(payload_i) ) as lowercase hex
// prevHash_0 = 64 zeros; prevHash_i = hash_(i-1) for i > 0

const ZERO_HASH = '0'.repeat(64);
const HASH_RE = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ALLOWED_KEYS = new Set(['sequence', 'payload', 'prevHash', 'hash']);

const DEFAULT_LIMITS = Object.freeze({
  maxLines: 500,
  maxDecompressedBytes: 2 * 1024 * 1024, // 2 MiB
});

class BatchError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'BatchError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

function decodeBase64Strict(value, line) {
  if (value.length === 0) return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new BatchError(400, 'PAYLOAD_NOT_BASE64',
      'payload is not valid canonical Base64', { line });
  }
  const decoded = Buffer.from(value, 'base64');
  // Reject non-canonical encodings (e.g. missing/ambiguous padding).
  if (decoded.toString('base64') !== value) {
    throw new BatchError(400, 'PAYLOAD_NOT_BASE64',
      'payload is not valid canonical Base64', { line });
  }
  return decoded;
}

function splitLines(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new BatchError(400, 'INVALID_NDJSON', 'batch is not valid UTF-8 NDJSON');
  }
  // A single trailing newline is a normal line terminator, not an extra empty line.
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const rawLines = text.split('\n');
  return rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function buildRows(buf, limits = DEFAULT_LIMITS) {
  const maxLines = limits.maxLines ?? DEFAULT_LIMITS.maxLines;
  const maxBytes = limits.maxDecompressedBytes ?? DEFAULT_LIMITS.maxDecompressedBytes;

  if (buf.length > maxBytes) {
    throw new BatchError(413, 'BATCH_TOO_LARGE',
      `decompressed batch exceeds ${maxBytes} bytes`,
      { size: buf.length, maxBytes });
  }

  const jsonLines = splitLines(buf);
  if (jsonLines.length === 0 || (jsonLines.length === 1 && jsonLines[0] === '')) {
    throw new BatchError(400, 'EMPTY_BATCH',
      'batch must contain between 1 and 500 lines', { count: 0, maxLines });
  }
  if (jsonLines.length > maxLines) {
    throw new BatchError(413, 'BATCH_TOO_MANY_LINES',
      `batch line count ${jsonLines.length} exceeds limit ${maxLines}`,
      { count: jsonLines.length, maxLines });
  }

  const rows = [];
  let expectedPrevHash = ZERO_HASH;

  for (let i = 0; i < jsonLines.length; i += 1) {
    const line = i + 1;
    const text = jsonLines[i];
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new BatchError(400, 'INVALID_NDJSON',
        `line ${line} is not valid JSON`, { line });
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new BatchError(400, 'INVALID_LINE',
        `line ${line} must be a JSON object`, { line });
    }
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new BatchError(400, 'INVALID_LINE',
          `line ${line} contains unexpected field "${key}"`, { line, field: key });
      }
    }

    const { sequence, payload, prevHash, hash } = obj;

    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
      throw new BatchError(400, 'INVALID_SEQUENCE',
        `line ${line} has an invalid sequence`, { line, received: sequence });
    }
    if (sequence !== i) {
      throw new BatchError(400, 'SEQUENCE_MISMATCH',
        `line ${line} sequence must be ${i}`, { line, expected: i, received: sequence });
    }
    if (typeof payload !== 'string') {
      throw new BatchError(400, 'INVALID_FIELD',
        `line ${line} payload must be a string`, { line, field: 'payload' });
    }
    if (typeof prevHash !== 'string' || !HASH_RE.test(prevHash)) {
      throw new BatchError(400, 'INVALID_FIELD',
        `line ${line} prevHash must be 64 lowercase hex characters`,
        { line, field: 'prevHash' });
    }
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      throw new BatchError(400, 'INVALID_FIELD',
        `line ${line} hash must be 64 lowercase hex characters`,
        { line, field: 'hash' });
    }
    if (prevHash !== expectedPrevHash) {
      throw new BatchError(422, 'PREV_HASH_MISMATCH',
        `line ${line} prevHash does not extend the hash chain`,
        { line, expected: expectedPrevHash, received: prevHash });
    }

    const payloadBytes = decodeBase64Strict(payload, line);
    const computedHash = crypto
      .createHash('sha256')
      .update(Buffer.from(prevHash, 'hex'))
      .update(payloadBytes)
      .digest('hex');

    if (computedHash !== hash) {
      throw new BatchError(422, 'HASH_MISMATCH',
        `line ${line} hash is inconsistent with prevHash and payload`,
        { line, expected: computedHash, received: hash });
    }

    rows.push({ sequence: i, payload, prevHash, hash });
    expectedPrevHash = hash;
  }

  return rows;
}

// Re-verify already-parsed rows (used when loading committed records from disk).
function verifyRows(rows, finalHash) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > DEFAULT_LIMITS.maxLines) {
    throw new BatchError(410, 'RECORD_CORRUPT', 'stored record has invalid row set');
  }
  let expectedPrevHash = ZERO_HASH;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.sequence !== i ||
        typeof row.payload !== 'string' ||
        typeof row.prevHash !== 'string' || !HASH_RE.test(row.prevHash) ||
        typeof row.hash !== 'string' || !HASH_RE.test(row.hash)) {
      throw new BatchError(410, 'RECORD_CORRUPT', `stored line ${i + 1} is malformed`, { line: i + 1 });
    }
    if (row.prevHash !== expectedPrevHash) {
      throw new BatchError(410, 'RECORD_CORRUPT',
        `stored line ${i + 1} breaks the hash chain`, { line: i + 1 });
    }
    let payloadBytes;
    try {
      payloadBytes = decodeBase64Strict(row.payload, i + 1);
    } catch {
      throw new BatchError(410, 'RECORD_CORRUPT',
        `stored line ${i + 1} has invalid Base64 payload`, { line: i + 1 });
    }
    const computed = require('crypto')
      .createHash('sha256')
      .update(Buffer.from(row.prevHash, 'hex'))
      .update(payloadBytes)
      .digest('hex');
    if (computed !== row.hash) {
      throw new BatchError(410, 'RECORD_CORRUPT',
        `stored line ${i + 1} fails hash verification`, { line: i + 1 });
    }
    expectedPrevHash = row.hash;
  }
  if (typeof finalHash !== 'string' || !HASH_RE.test(finalHash) ||
      finalHash !== rows[rows.length - 1].hash) {
    throw new BatchError(410, 'RECORD_CORRUPT', 'stored final hash is inconsistent');
  }
}

// Full validation of an uploaded decompressed batch.
function verifyBatch(buf, finalHash, limits = DEFAULT_LIMITS) {
  if (typeof finalHash !== 'string' || !HASH_RE.test(finalHash)) {
    throw new BatchError(400, 'FINAL_HASH_INVALID',
      'X-Final-Hash must be 64 lowercase hex characters');
  }
  const rows = buildRows(buf, limits);
  const lastHash = rows[rows.length - 1].hash;
  if (lastHash !== finalHash) {
    throw new BatchError(422, 'FINAL_HASH_MISMATCH',
      'X-Final-Hash does not match the hash of the last line',
      { expected: lastHash, received: finalHash });
  }
  return { rows, finalHash, count: rows.length };
}

module.exports = {
  ZERO_HASH,
  HASH_RE,
  DEFAULT_LIMITS,
  BatchError,
  isValidRunId,
  buildRows,
  verifyRows,
  verifyBatch,
};
