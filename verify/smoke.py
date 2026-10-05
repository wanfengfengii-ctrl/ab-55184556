"""End-to-end smoke tests against a live API: plaintext and gzip commits,
read-back, and the failure cases (truncation, tampering, duplicates).

Uses only the standard library so it can run in the same image without
extra dependencies. Run ids are unique per invocation so the suite is
repeatable against a persistent volume.
"""
from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.request

from verify.chain import ZERO_HASH, build_lines, encode_ndjson, final_hash


class SmokeFailure(Exception):
    pass


def _request(
    base: str,
    method: str,
    path: str,
    body: bytes | None = None,
    headers: dict | None = None,
) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(
        base + path, data=body, method=method, headers=headers or {}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def _expect(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def _expect_error(
    base: str,
    method: str,
    path: str,
    body: bytes | None,
    headers: dict | None,
    want_status: int,
    want_code: str,
) -> None:
    status, _headers, raw = _request(base, method, path, body, headers)
    _expect(
        status == want_status,
        f"{method} {path}: expected HTTP {want_status}, got {status}: {raw!r}",
    )
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        raise SmokeFailure(
            f"{method} {path}: error body is not JSON: {raw!r}"
        ) from None
    error = payload.get("error") if isinstance(payload, dict) else None
    _expect(
        isinstance(error, dict),
        f"{method} {path}: response has no structured 'error' object: {payload!r}",
    )
    _expect(
        error.get("code") == want_code,
        f"{method} {path}: expected error code {want_code!r}, got {error.get('code')!r}",
    )
    _expect(
        isinstance(error.get("message"), str) and isinstance(error.get("details"), dict),
        f"{method} {path}: error object lacks message/details: {error!r}",
    )


def _unique_run_id(prefix: str) -> str:
    return f"{prefix}-{int(time.time() * 1000)}-{id(prefix) % 100000:05d}"


def _commit_and_read_back(base: str, run_id: str, lines: list[dict], gzipped: bool) -> None:
    ndjson = encode_ndjson(lines)
    if gzipped:
        body = gzip.compress(ndjson)
        headers = {"Content-Encoding": "gzip", "X-Final-Hash": final_hash(lines)}
    else:
        body = ndjson
        headers = {"X-Final-Hash": final_hash(lines)}

    status, resp_headers, raw = _request(
        base, "POST", f"/api/runs/{run_id}", body, headers
    )
    resp_headers = {k.lower(): v for k, v in resp_headers.items()}
    _expect(status == 201, f"POST {run_id}: expected 201, got {status}: {raw!r}")
    created = json.loads(raw)
    _expect(created.get("runId") == run_id, f"POST {run_id}: wrong runId in response")
    _expect(created.get("lineCount") == len(lines), f"POST {run_id}: wrong lineCount")
    _expect(
        created.get("finalHash") == final_hash(lines),
        f"POST {run_id}: wrong finalHash",
    )
    _expect(
        resp_headers.get("location") == f"/api/runs/{run_id}",
        f"POST {run_id}: missing or wrong Location header",
    )

    status, _h, raw = _request(base, "GET", f"/api/runs/{run_id}")
    _expect(status == 200, f"GET {run_id}: expected 200, got {status}: {raw!r}")
    fetched = json.loads(raw)
    _expect(fetched.get("runId") == run_id, f"GET {run_id}: wrong runId")
    _expect(fetched.get("lineCount") == len(lines), f"GET {run_id}: wrong lineCount")
    _expect(
        fetched.get("finalHash") == final_hash(lines),
        f"GET {run_id}: wrong finalHash",
    )
    _expect(
        fetched.get("lines") == lines,
        f"GET {run_id}: stored lines differ from submitted lines",
    )
    sequences = [line["sequence"] for line in fetched["lines"]]
    _expect(
        sequences == sorted(sequences) == list(range(len(lines))),
        f"GET {run_id}: lines not returned in sequence order",
    )


def check_plaintext_commit_and_read(base: str) -> None:
    lines = build_lines([b"spectrum-1", b"spectrum-2", b"spectrum-3"])
    _commit_and_read_back(base, _unique_run_id("smoke-plain"), lines, gzipped=False)


def check_gzip_commit_and_read(base: str) -> None:
    lines = build_lines([b"gzip-spectrum-1", b"gzip-spectrum-2"])
    _commit_and_read_back(base, _unique_run_id("smoke-gzip"), lines, gzipped=True)


def check_missing_run_returns_404(base: str) -> None:
    _expect_error(
        base, "GET", f"/api/runs/{_unique_run_id('smoke-missing')}",
        None, None, 404, "run_not_found",
    )


def check_truncated_batch_rejected(base: str) -> None:
    # The acquisition process crashed mid-batch: only a prefix is resent,
    # but X-Final-Hash still commits to the full batch's last hash.
    run_id = _unique_run_id("smoke-truncated")
    lines = build_lines([b"a", b"b", b"c", b"d"])
    truncated = encode_ndjson(lines[:2])
    _expect_error(
        base, "POST", f"/api/runs/{run_id}", truncated,
        {"X-Final-Hash": final_hash(lines)}, 400, "final_hash_mismatch",
    )
    # No half batch may be left behind.
    _expect_error(base, "GET", f"/api/runs/{run_id}", None, None, 404, "run_not_found")


def check_tampered_hash_rejected(base: str) -> None:
    run_id = _unique_run_id("smoke-tampered-hash")
    lines = build_lines([b"a", b"b", b"c"])
    lines[1]["hash"] = "0" * 64  # break the chain digest
    _expect_error(
        base, "POST", f"/api/runs/{run_id}", encode_ndjson(lines),
        {"X-Final-Hash": lines[-1]["hash"]}, 400, "hash_mismatch",
    )
    _expect_error(base, "GET", f"/api/runs/{run_id}", None, None, 404, "run_not_found")


def check_tampered_prev_hash_rejected(base: str) -> None:
    run_id = _unique_run_id("smoke-tampered-prev")
    lines = build_lines([b"a", b"b"])
    lines[1]["prevHash"] = ZERO_HASH  # chain link no longer matches line 0
    _expect_error(
        base, "POST", f"/api/runs/{run_id}", encode_ndjson(lines),
        {"X-Final-Hash": lines[-1]["hash"]}, 400, "prev_hash_mismatch",
    )
    _expect_error(base, "GET", f"/api/runs/{run_id}", None, None, 404, "run_not_found")


def check_duplicate_run_rejected(base: str) -> None:
    run_id = _unique_run_id("smoke-duplicate")
    lines = build_lines([b"first-batch"])
    _commit_and_read_back(base, run_id, lines, gzipped=False)
    # A resend of the same run id must not overwrite the committed batch.
    other = build_lines([b"second-batch"])
    _expect_error(
        base, "POST", f"/api/runs/{run_id}", encode_ndjson(other),
        {"X-Final-Hash": final_hash(other)}, 409, "run_already_exists",
    )
    status, _h, raw = _request(base, "GET", f"/api/runs/{run_id}")
    _expect(status == 200, f"GET {run_id}: expected 200, got {status}")
    _expect(
        json.loads(raw)["lines"] == lines,
        f"GET {run_id}: committed batch was modified by a duplicate POST",
    )


def check_sequence_gap_rejected(base: str) -> None:
    run_id = _unique_run_id("smoke-sequence")
    lines = build_lines([b"a", b"b"])
    lines[1]["sequence"] = 5
    _expect_error(
        base, "POST", f"/api/runs/{run_id}", encode_ndjson(lines),
        {"X-Final-Hash": lines[-1]["hash"]}, 400, "sequence_mismatch",
    )


def check_missing_final_hash_rejected(base: str) -> None:
    run_id = _unique_run_id("smoke-no-final")
    lines = build_lines([b"a"])
    _expect_error(
        base, "POST", f"/api/runs/{run_id}", encode_ndjson(lines),
        None, 400, "final_hash_missing",
    )


def check_invalid_gzip_rejected(base: str) -> None:
    run_id = _unique_run_id("smoke-bad-gzip")
    _expect_error(
        base, "POST", f"/api/runs/{run_id}", b"this is not gzip data",
        {"Content-Encoding": "gzip", "X-Final-Hash": "0" * 64}, 400, "invalid_gzip",
    )


def check_too_many_lines_rejected(base: str) -> None:
    run_id = _unique_run_id("smoke-too-many")
    lines = build_lines([b"x"] * 501)
    _expect_error(
        base, "POST", f"/api/runs/{run_id}", encode_ndjson(lines),
        {"X-Final-Hash": final_hash(lines)}, 400, "too_many_lines",
    )


_CHECKS = [
    ("plaintext commit + read-back", check_plaintext_commit_and_read),
    ("gzip commit + read-back", check_gzip_commit_and_read),
    ("missing run -> 404 run_not_found", check_missing_run_returns_404),
    ("truncated batch -> 400, nothing stored", check_truncated_batch_rejected),
    ("tampered hash -> 400, nothing stored", check_tampered_hash_rejected),
    ("tampered prevHash -> 400, nothing stored", check_tampered_prev_hash_rejected),
    ("duplicate run id -> 409, original kept", check_duplicate_run_rejected),
    ("sequence gap -> 400", check_sequence_gap_rejected),
    ("missing X-Final-Hash -> 400", check_missing_final_hash_rejected),
    ("invalid gzip -> 400", check_invalid_gzip_rejected),
    ("501 lines -> 400 too_many_lines", check_too_many_lines_rejected),
]


def run_smoke(base: str) -> bool:
    print(f"[verify] running {len(_CHECKS)} smoke checks against {base}", flush=True)
    failures = 0
    for name, check in _CHECKS:
        try:
            check(base)
        except Exception as exc:  # noqa: BLE001 - report and continue
            failures += 1
            print(f"[verify] FAIL {name}: {exc}", flush=True)
        else:
            print(f"[verify] PASS {name}", flush=True)
    if failures:
        print(f"[verify] {failures}/{len(_CHECKS)} smoke checks failed", flush=True)
        return False
    print(f"[verify] all {len(_CHECKS)} smoke checks passed", flush=True)
    return True
