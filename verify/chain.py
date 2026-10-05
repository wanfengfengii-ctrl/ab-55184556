"""Client-side helpers to build spec-compliant batches.

Used by the smoke tests and the unit tests; mirrors exactly what the
acquisition client sends.
"""
from __future__ import annotations

import base64
import hashlib
import json

ZERO_HASH = "0" * 64


def build_lines(payloads: list[bytes]) -> list[dict]:
    """Build valid NDJSON line objects for the given raw payloads."""
    lines = []
    prev_hash = ZERO_HASH
    for index, payload_bytes in enumerate(payloads):
        digest = hashlib.sha256(bytes.fromhex(prev_hash) + payload_bytes).hexdigest()
        lines.append(
            {
                "sequence": index,
                "payload": base64.b64encode(payload_bytes).decode("ascii"),
                "prevHash": prev_hash,
                "hash": digest,
            }
        )
        prev_hash = digest
    return lines


def encode_ndjson(lines: list[dict]) -> bytes:
    """Encode line objects as NDJSON with a trailing newline."""
    return ("\n".join(json.dumps(line) for line in lines) + "\n").encode("utf-8")


def final_hash(lines: list[dict]) -> str:
    return lines[-1]["hash"]
