"""Validation logic for spectrum-run batches.

The acquisition client resends a whole batch after a crash, so a batch is
only ever accepted or rejected as a unit: every line must parse, the
hash chain must be intact from ``sequence`` 0 to the last line, and the
last line's hash must match the ``X-Final-Hash`` commitment. Anything
less is rejected with a stable, structured error and nothing is stored.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import zlib
from dataclasses import dataclass

MAX_LINES = 500
MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024  # 2 MiB, applied to the NDJSON text
# 2 MiB of incompressible data gzips to slightly more than 2 MiB, so a
# compressed body beyond this bound can never decode to a legal batch.
MAX_COMPRESSED_BYTES = MAX_DECOMPRESSED_BYTES + 64 * 1024
ZERO_HASH = "0" * 64
_HEX_CHARS = frozenset("0123456789abcdef")
_GZIP_MAGIC = b"\x1f\x8b"


class BatchError(Exception):
    """A client-facing failure with a stable machine-readable code."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 400,
        details: dict | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}


@dataclass(frozen=True)
class Line:
    """One validated NDJSON line."""

    sequence: int
    payload: str  # base64 text, exactly as received
    prev_hash: str
    hash: str


def _is_hex64(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(ch in _HEX_CHARS for ch in value)
    )


def gunzip_limited(data: bytes, limit: int | None = None) -> bytes:
    """Decompress a gzip stream, refusing output larger than ``limit`` bytes.

    The limit is enforced while decompressing so a gzip bomb is stopped
    before it can expand in memory.
    """
    if limit is None:
        limit = MAX_DECOMPRESSED_BYTES
    decomp = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    try:
        out = decomp.decompress(data, limit + 1)
        out += decomp.flush()
    except zlib.error as exc:
        raise BatchError(
            "invalid_gzip", f"request body is not valid gzip data: {exc}"
        ) from exc
    if len(out) > limit:
        raise BatchError(
            "payload_too_large",
            f"decompressed body exceeds the {limit}-byte limit",
            status=413,
            details={"limit": limit},
        )
    if not decomp.eof:
        raise BatchError("invalid_gzip", "gzip stream is truncated")
    return out


def decode_body(body: bytes, content_encoding: str | None) -> bytes:
    """Return the raw NDJSON bytes of a request body.

    Honours ``Content-Encoding: gzip`` and, as a fallback, bodies that
    start with the gzip magic bytes. Any other content encoding is
    rejected.
    """
    encoding = (content_encoding or "").strip().lower()
    if encoding in ("", "identity"):
        if body[:2] == _GZIP_MAGIC:
            encoding = "gzip"
        else:
            if len(body) > MAX_DECOMPRESSED_BYTES:
                raise BatchError(
                    "payload_too_large",
                    f"body exceeds the {MAX_DECOMPRESSED_BYTES}-byte limit",
                    status=413,
                    details={"limit": MAX_DECOMPRESSED_BYTES},
                )
            return body
    if encoding == "gzip":
        if len(body) > MAX_COMPRESSED_BYTES:
            raise BatchError(
                "payload_too_large",
                "compressed body is too large to decode to a legal batch",
                status=413,
                details={"limit": MAX_COMPRESSED_BYTES},
            )
        return gunzip_limited(body)
    raise BatchError(
        "unsupported_content_encoding",
        f"unsupported Content-Encoding: {encoding!r}; use gzip or none",
        status=415,
    )


def parse_and_validate(data: bytes) -> list[Line]:
    """Parse NDJSON bytes and validate the whole hash chain.

    Returns the validated lines in order. Raises :class:`BatchError` on
    the first problem found; a rejected batch leaves nothing behind.
    """
    if not data:
        raise BatchError("empty_batch", "request body is empty")
    raw_lines = data.split(b"\n")
    if raw_lines and raw_lines[-1] == b"":
        raw_lines.pop()  # tolerate a single trailing newline
    if not raw_lines:
        raise BatchError("empty_batch", "batch contains no lines")
    if len(raw_lines) > MAX_LINES:
        raise BatchError(
            "too_many_lines",
            f"batch has {len(raw_lines)} lines, maximum is {MAX_LINES}",
            details={"count": len(raw_lines), "max": MAX_LINES},
        )

    lines: list[Line] = []
    prev_hash = ZERO_HASH
    for index, raw in enumerate(raw_lines):
        if raw.strip() == b"":
            raise BatchError(
                "empty_line",
                f"line {index} is empty",
                details={"line": index},
            )
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise BatchError(
                "invalid_json",
                f"line {index} is not valid JSON: {exc.msg}",
                details={"line": index},
            ) from exc
        if not isinstance(obj, dict):
            raise BatchError(
                "invalid_line",
                f"line {index} must be a JSON object",
                details={"line": index},
            )
        line = _validate_line(index, obj, prev_hash)
        lines.append(line)
        prev_hash = line.hash
    return lines


def _required_field(obj: dict, name: str, index: int) -> object:
    if name not in obj:
        raise BatchError(
            "missing_field",
            f"line {index} is missing field {name!r}",
            details={"line": index, "field": name},
        )
    return obj[name]


def _validate_line(index: int, obj: dict, expected_prev_hash: str) -> Line:
    sequence = _required_field(obj, "sequence", index)
    if isinstance(sequence, bool) or not isinstance(sequence, int):
        raise BatchError(
            "invalid_field",
            f"line {index}: 'sequence' must be an integer",
            details={"line": index, "field": "sequence", "reason": "not an integer"},
        )
    if sequence != index:
        raise BatchError(
            "sequence_mismatch",
            f"line {index}: 'sequence' must equal its zero-based position",
            details={"line": index, "expected": index, "actual": sequence},
        )

    payload = _required_field(obj, "payload", index)
    if not isinstance(payload, str):
        raise BatchError(
            "invalid_field",
            f"line {index}: 'payload' must be a base64 string",
            details={"line": index, "field": "payload", "reason": "not a string"},
        )
    try:
        payload_bytes = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BatchError(
            "invalid_base64",
            f"line {index}: 'payload' is not valid base64",
            details={"line": index},
        ) from exc

    prev_hash = _required_field(obj, "prevHash", index)
    if not _is_hex64(prev_hash):
        raise BatchError(
            "invalid_field",
            f"line {index}: 'prevHash' must be 64 lowercase hex characters",
            details={
                "line": index,
                "field": "prevHash",
                "reason": "not 64 lowercase hex characters",
            },
        )
    if prev_hash != expected_prev_hash:
        raise BatchError(
            "prev_hash_mismatch",
            f"line {index}: 'prevHash' does not match the previous line's hash",
            details={
                "line": index,
                "expected": expected_prev_hash,
                "actual": prev_hash,
            },
        )

    hash_value = _required_field(obj, "hash", index)
    if not _is_hex64(hash_value):
        raise BatchError(
            "invalid_field",
            f"line {index}: 'hash' must be 64 lowercase hex characters",
            details={
                "line": index,
                "field": "hash",
                "reason": "not 64 lowercase hex characters",
            },
        )
    computed = hashlib.sha256(bytes.fromhex(prev_hash) + payload_bytes).hexdigest()
    if hash_value != computed:
        raise BatchError(
            "hash_mismatch",
            f"line {index}: 'hash' does not match SHA-256(prevHash bytes || payload bytes)",
            details={"line": index, "expected": computed, "actual": hash_value},
        )

    return Line(sequence=index, payload=payload, prev_hash=prev_hash, hash=hash_value)


def validate_final_hash(lines: list[Line], header: str | None) -> str:
    """Check the ``X-Final-Hash`` commitment against the last line's hash."""
    if header is None or header.strip() == "":
        raise BatchError("final_hash_missing", "X-Final-Hash header is required")
    final_hash = header.strip()
    if not _is_hex64(final_hash):
        raise BatchError(
            "invalid_final_hash",
            "X-Final-Hash must be 64 lowercase hex characters",
        )
    last_hash = lines[-1].hash
    if final_hash != last_hash:
        raise BatchError(
            "final_hash_mismatch",
            "X-Final-Hash does not match the hash of the last line; "
            "the batch is truncated or was reassembled incorrectly",
            details={"expected": last_hash, "actual": final_hash},
        )
    return final_hash
