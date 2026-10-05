'use strict';

// Write-once, crash-safe run storage.
//
// Commit protocol:
//   1. fully validate the batch in memory (nothing queryable is ever written)
//   2. write a unique temp file, fsync it
//   3. fs.link(tmp, final) -> fails with EEXIST if the run already exists,
//      even under concurrent requests / multiple processes (atomic create)
//   4. fsync the directory and unlink the temp name
//
// A crash at any point leaves at most an orphan *.tmp file, which is never
// served and is swept on the next startup.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { verifyRows, BatchError } = require('./chain');

const RECORD_VERSION = 1;
const RECORD_SUFFIX = '.json';
const TMP_PREFIX = '.tmp-';

class Storage {
  constructor(dataDir, { logger = console } = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.records = new Map(); // runId -> record (immutable once present)
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });

    const names = await fsp.readdir(this.dataDir);
    for (const name of names) {
      const full = path.join(this.dataDir, name);
      if (name.startsWith(TMP_PREFIX)) {
        await this.#sweep(full);
        continue;
      }
      if (!name.endsWith(RECORD_SUFFIX)) continue;
      try {
        const text = await fsp.readFile(full, 'utf8');
        const record = JSON.parse(text);
        this.#validateRecordShape(record, name);
        verifyRows(record.rows, record.finalHash);
        this.records.set(record.runId, record);
      } catch (err) {
        // A record we cannot verify is never exposed as a complete experiment.
        // Quarantine it (kept for forensics, never served) so the runId is not
        // permanently wedged: the collector can re-send a valid batch.
        this.logger.error?.(`quarantining unverifiable record ${name}: ${err.message}`);
        await this.#quarantine(full, name);
      }
    }
  }

  #validateRecordShape(record, name) {
    if (!record || record.version !== RECORD_VERSION ||
        typeof record.runId !== 'string' ||
        typeof record.finalHash !== 'string' ||
        !Array.isArray(record.rows)) {
      throw new BatchError(410, 'RECORD_CORRUPT', `record ${name} has an invalid shape`);
    }
    const expectedFile = `${record.runId}${RECORD_SUFFIX}`;
    if (expectedFile !== name) {
      throw new BatchError(410, 'RECORD_CORRUPT',
        `record ${name} runId does not match its file name`);
    }
  }

  async #sweep(full) {
    try {
      await fsp.unlink(full);
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger.warn?.(`could not remove temp file ${full}: ${err.message}`);
    }
  }

  async #quarantine(full, name) {
    const quarantined = path.join(
      this.dataDir,
      `.quarantine-${name}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      await fsp.rename(full, quarantined);
      this.logger.warn?.(`record ${name} moved to ${path.basename(quarantined)}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.error?.(`could not quarantine ${name}: ${err.message}`);
      }
    }
  }

  has(runId) {
    return this.records.has(runId);
  }

  get(runId) {
    return this.records.get(runId) ?? null;
  }

  // Atomically commit a validated batch. Throws BatchError(409) if runId taken.
  async commit(runId, { rows, finalHash }) {
    const finalPath = path.join(this.dataDir, `${runId}${RECORD_SUFFIX}`);
    const tmpName = `${TMP_PREFIX}${runId}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    const tmpPath = path.join(this.dataDir, tmpName);

    const record = {
      version: RECORD_VERSION,
      runId,
      finalHash,
      count: rows.length,
      committedAt: new Date().toISOString(),
      rows,
    };
    const payload = `${JSON.stringify(record)}\n`;

    let tmpFd;
    try {
      tmpFd = await fsp.open(tmpPath, 'wx', 0o600);
      await tmpFd.writeFile(payload, 'utf8');
      await tmpFd.sync();
      await tmpFd.close();
      tmpFd = undefined;

      // Atomic create of the final name: EEXIST means a concurrent committer won.
      try {
        await fsp.link(tmpPath, finalPath);
      } catch (err) {
        if (err.code === 'EEXIST') {
          throw new BatchError(409, 'RUN_ALREADY_EXISTS',
            `run "${runId}" has already been committed`, { runId });
        }
        throw err;
      }

      // Best-effort directory fsync so the link is durable.
      try {
        const dirFd = await fsp.open(this.dataDir, 'r');
        try {
          await dirFd.sync();
        } finally {
          await dirFd.close();
        }
      } catch (err) {
        this.logger.warn?.(`directory fsync failed: ${err.message}`);
      }

      this.records.set(runId, record);
      return record;
    } finally {
      if (tmpFd !== undefined) {
        try { await tmpFd.close(); } catch { /* already closed */ }
      }
      await this.#sweep(tmpPath);
    }
  }
}

module.exports = { Storage };
