'use strict';

// HTTP application: NDJSON run ingestion with hash-chain verification.
//
// POST /api/runs/:runId   NDJSON body, optional Content-Encoding: gzip,
//                         X-Final-Hash header required  -> 201 on full success
// GET  /api/runs/:runId   committed rows in sequence order
// GET  /healthz           liveness/readiness probe
//
// Any failed POST leaves nothing queryable (validation happens entirely in
// memory before the atomic storage commit).

const { createServer } = require('http');
const zlib = require('zlib');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const {
  BatchError,
  isValidRunId,
  verifyBatch,
  DEFAULT_LIMITS,
} = require('./chain');
const { Storage } = require('./storage');

const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024; // hard cap on the upload itself
const ROUTE_RE = /^\/api\/runs\/([^/]+)\/?$/;

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function errorBody(err, runId) {
  if (err instanceof BatchError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(runId ? { runId } : {}),
        ...(Object.keys(err.details).length ? { details: err.details } : {}),
      },
    };
  }
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'internal server error',
      ...(runId ? { runId } : {}),
    },
  };
}

function limitTransform(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) {
        cb(new BatchError(413, 'BATCH_TOO_LARGE',
          `decompressed batch exceeds ${limit} bytes`, { size: seen, maxBytes: limit }));
        return;
      }
      cb(null, chunk);
    },
  });
}

async function readBody(req, limits) {
  const chunks = [];
  let rawSize = 0;
  const rawLimit = new Transform({
    transform(chunk, _enc, cb) {
      rawSize += chunk.length;
      if (rawSize > MAX_COMPRESSED_BYTES) {
        cb(new BatchError(413, 'UPLOAD_TOO_LARGE',
          `upload body exceeds ${MAX_COMPRESSED_BYTES} bytes`,
          { size: rawSize, maxBytes: MAX_COMPRESSED_BYTES }));
        return;
      }
      cb(null, chunk);
    },
  });
  const sizeLimit = limitTransform(limits.maxDecompressedBytes);

  const encoding = (req.headers['content-encoding'] ?? 'identity').toLowerCase();
  let decoder;
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    decoder = zlib.createGunzip();
    decoder.on('error', () => {}); // surfaced through pipeline rejection
  } else if (encoding === 'identity' || encoding === '') {
    decoder = new Transform({ transform(c, _e, cb) { cb(null, c); } });
  } else {
    throw new BatchError(415, 'UNSUPPORTED_CONTENT_ENCODING',
      `unsupported Content-Encoding "${encoding}"`, { encoding });
  }

  try {
    await pipeline(req, rawLimit, decoder, sizeLimit, async function* collect(stream) {
      for await (const chunk of stream) chunks.push(chunk);
    });
  } catch (err) {
    if (err instanceof BatchError) throw err;
    if (err?.code === 'Z_BUF_ERROR' || err?.code === 'Z_DATA_ERROR') {
      throw new BatchError(400, 'INVALID_GZIP',
        'request body is not a valid gzip stream');
    }
    if (err?.code === 'ECONNRESET' || err?.name === 'AbortError') {
      throw new BatchError(400, 'UPLOAD_INTERRUPTED', 'request body upload was interrupted');
    }
    throw new BatchError(400, 'UNREADABLE_BODY', `could not read request body: ${err.message}`);
  }

  return Buffer.concat(chunks);
}

function createApp(storage, { limits = DEFAULT_LIMITS, logger = console } = {}) {
  // Serialize the validate+commit critical section per runId. The storage
  // layer's atomic link() is the cross-process authority; this chain only
  // avoids racing duplicate work within the process.
  const inflight = new Map(); // runId -> Promise

  function serialize(runId, task) {
    const previous = inflight.get(runId) || Promise.resolve();
    const current = previous.then(task, task);
    inflight.set(runId, current);
    current.finally(() => {
      if (inflight.get(runId) === current) inflight.delete(runId);
    }).catch(() => {});
    return current;
  }

  function handleGetRun(res, runId) {
    const record = storage.get(runId);
    if (!record) {
      sendJson(res, 404, errorBody(
        new BatchError(404, 'RUN_NOT_FOUND', `run "${runId}" does not exist`), runId));
      return;
    }
    sendJson(res, 200, {
      runId: record.runId,
      status: 'committed',
      count: record.count,
      finalHash: record.finalHash,
      committedAt: record.committedAt,
      rows: record.rows,
    });
  }

  async function handlePostRun(req, res, runId) {
    if (storage.has(runId)) {
      req.resume(); // drain; nothing to validate for a known-duplicate
      sendJson(res, 409, errorBody(
        new BatchError(409, 'RUN_ALREADY_EXISTS',
          `run "${runId}" has already been committed`, { runId }), runId));
      return;
    }

    const finalHash = req.headers['x-final-hash'];

    // Read/decompress fully before the critical section: a failed upload
    // never enters storage, and must not block a concurrent valid one.
    let body;
    try {
      body = await readBody(req, limits);
    } catch (err) {
      const status = err instanceof BatchError ? err.status : 400;
      if (!(err instanceof BatchError)) logger.error?.(err);
      sendJson(res, status, errorBody(err, runId));
      return;
    }

    try {
      const record = await serialize(runId, async () => {
        if (storage.has(runId)) {
          throw new BatchError(409, 'RUN_ALREADY_EXISTS',
            `run "${runId}" has already been committed`, { runId });
        }
        // Entire validation happens in memory; only an all-valid batch
        // reaches the atomic storage commit.
        const { rows, finalHash: fh } = verifyBatch(body, finalHash, limits);
        return storage.commit(runId, { rows, finalHash: fh });
      });

      sendJson(res, 201, {
        runId: record.runId,
        status: 'committed',
        count: record.count,
        finalHash: record.finalHash,
        committedAt: record.committedAt,
      }, { location: `/api/runs/${encodeURIComponent(runId)}` });
    } catch (err) {
      const status = err instanceof BatchError ? err.status : 500;
      if (!(err instanceof BatchError)) logger.error?.(err);
      sendJson(res, status, errorBody(err, runId));
    }
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      const match = pathname.match(ROUTE_RE);
      if (!match) {
        sendJson(res, 404, errorBody(
          new BatchError(404, 'NOT_FOUND', `no route for ${pathname}`)));
        return;
      }

      const rawRunId = decodeURIComponent(match[1]);
      if (!isValidRunId(rawRunId)) {
        sendJson(res, 400, errorBody(
          new BatchError(400, 'INVALID_RUN_ID',
            'runId must be 1-128 chars of [A-Za-z0-9_-]', { runId: rawRunId })));
        return;
      }
      const runId = rawRunId;

      if (req.method === 'GET') {
        handleGetRun(res, runId);
      } else if (req.method === 'POST') {
        await handlePostRun(req, res, runId);
      } else {
        sendJson(res, 405, errorBody(
          new BatchError(405, 'METHOD_NOT_ALLOWED',
            `method ${req.method} not allowed`)), { allow: 'GET, POST' });
      }
    } catch (err) {
      if (res.headersSent) {
        req.destroy();
        return;
      }
      const status = err instanceof BatchError ? err.status : 500;
      if (!(err instanceof BatchError)) logger.error?.(err);
      sendJson(res, status, errorBody(err));
    }
  }

  return createServer(handler);
}

module.exports = { createApp, readBody };

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || '/data';
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';

  const storage = new Storage(dataDir);
  storage.init().then(() => {
    const server = createApp(storage);
    server.listen(port, host, () => {
      console.log(`mass-spec run archive listening on http://${host}:${port} (data: ${dataDir})`);
    });

    const shutdown = (signal) => {
      console.log(`received ${signal}, shutting down`);
      // Force idle (keep-alive) connections closed so container stop does
      // not have to wait the full graceful timeout.
      server.closeAllConnections?.();
      server.close(() => process.exit(0));
      // Hard safety net in case active uploads keep close() pending.
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }).catch((err) => {
    console.error('failed to initialize storage:', err);
    process.exit(1);
  });
}
