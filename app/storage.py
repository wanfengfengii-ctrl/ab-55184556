"""SQLite-backed storage for committed runs.

A batch is committed in a single ``BEGIN IMMEDIATE`` transaction, so a
run is either stored completely or not at all — a failed or concurrent
submission can never leave half a batch queryable. The ``run_id``
primary key guarantees that exactly one batch per run id ever commits,
even under concurrent requests or across container restarts (the
database lives on a mounted volume).
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone

from app.validation import Line

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id       TEXT PRIMARY KEY,
    final_hash   TEXT NOT NULL,
    line_count   INTEGER NOT NULL,
    committed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lines (
    run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    payload  TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash     TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
);
"""


class RunExistsError(Exception):
    """Raised when a run id has already been committed."""

    def __init__(self, run_id: str):
        super().__init__(f"run {run_id!r} already exists")
        self.run_id = run_id


class Storage:
    def __init__(self, db_path: str):
        self.db_path = db_path
        directory = os.path.dirname(os.path.abspath(db_path))
        os.makedirs(directory, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _init_schema(self) -> None:
        conn = self._connect()
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()

    def commit_run(self, run_id: str, lines: list[Line]) -> None:
        """Atomically store a fully validated batch.

        Raises :class:`RunExistsError` if the run id is already committed.
        """
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "INSERT INTO runs (run_id, final_hash, line_count, committed_at)"
                " VALUES (?, ?, ?, ?)",
                (
                    run_id,
                    lines[-1].hash,
                    len(lines),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.executemany(
                "INSERT INTO lines (run_id, sequence, payload, prev_hash, hash)"
                " VALUES (?, ?, ?, ?, ?)",
                [
                    (run_id, line.sequence, line.payload, line.prev_hash, line.hash)
                    for line in lines
                ],
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            raise RunExistsError(run_id) from exc
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def get_run(self, run_id: str) -> dict | None:
        """Return a committed run with its lines in sequence order, or None."""
        conn = self._connect()
        try:
            run = conn.execute(
                "SELECT run_id, final_hash, line_count, committed_at"
                " FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if run is None:
                return None
            rows = conn.execute(
                "SELECT sequence, payload, prev_hash, hash"
                " FROM lines WHERE run_id = ? ORDER BY sequence ASC",
                (run_id,),
            ).fetchall()
        finally:
            conn.close()
        return {
            "runId": run["run_id"],
            "lineCount": run["line_count"],
            "finalHash": run["final_hash"],
            "committedAt": run["committed_at"],
            "lines": [
                {
                    "sequence": row["sequence"],
                    "payload": row["payload"],
                    "prevHash": row["prev_hash"],
                    "hash": row["hash"],
                }
                for row in rows
            ],
        }
