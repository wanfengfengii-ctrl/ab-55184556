"""Integration tests for the HTTP API and the storage guarantees."""
import gzip
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.storage import RunExistsError, Storage
from verify.chain import ZERO_HASH, build_lines, encode_ndjson, final_hash


@pytest.fixture()
def client(tmp_path):
    app = create_app(str(tmp_path / "runs.db"))
    with TestClient(app) as test_client:
        yield test_client


def post_batch(client, run_id, lines, *, gzipped=False, final=None, headers=None):
    raw = encode_ndjson(lines)
    hdrs = dict(headers or {})
    if gzipped:
        body = gzip.compress(raw)
        hdrs["Content-Encoding"] = "gzip"
    else:
        body = raw
    if final is not None:
        hdrs["X-Final-Hash"] = final
    return client.post(f"/api/runs/{run_id}", content=body, headers=hdrs)


def valid_batch(payloads=(b"s1", b"s2", b"s3")):
    return build_lines(list(payloads))


class TestCommitAndRead:
    def test_commit_plaintext_201(self, client):
        lines = valid_batch()
        resp = post_batch(client, "run-1", lines, final=final_hash(lines))
        assert resp.status_code == 201
        body = resp.json()
        assert body["runId"] == "run-1"
        assert body["committed"] is True
        assert body["lineCount"] == 3
        assert body["finalHash"] == final_hash(lines)
        assert resp.headers["Location"] == "/api/runs/run-1"

    def test_commit_gzip_201(self, client):
        lines = valid_batch()
        resp = post_batch(client, "run-gz", lines, gzipped=True, final=final_hash(lines))
        assert resp.status_code == 201
        assert resp.json()["lineCount"] == 3

    def test_read_back_in_order(self, client):
        lines = valid_batch([b"a", b"b", b"c", b"d", b"e"])
        post_batch(client, "run-2", lines, final=final_hash(lines))
        resp = client.get("/api/runs/run-2")
        assert resp.status_code == 200
        body = resp.json()
        assert body["runId"] == "run-2"
        assert body["lineCount"] == 5
        assert body["finalHash"] == final_hash(lines)
        assert body["lines"] == lines
        assert [l["sequence"] for l in body["lines"]] == [0, 1, 2, 3, 4]

    def test_health(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


class TestStructuredFailures:
    def assert_error(self, resp, status, code):
        assert resp.status_code == status, resp.text
        body = resp.json()
        assert set(body) == {"error"}
        assert body["error"]["code"] == code
        assert isinstance(body["error"]["message"], str)
        assert isinstance(body["error"]["details"], dict)

    def test_missing_run_404(self, client):
        self.assert_error(client.get("/api/runs/nope"), 404, "run_not_found")

    def test_invalid_run_id(self, client):
        self.assert_error(client.get("/api/runs/bad%20id"), 400, "invalid_run_id")
        self.assert_error(client.get("/api/runs/" + "x" * 200), 400, "invalid_run_id")

    def test_unknown_route_structured(self, client):
        self.assert_error(client.get("/nope"), 404, "not_found")

    def test_truncated_batch_leaves_nothing(self, client):
        lines = valid_batch([b"a", b"b", b"c", b"d"])
        resp = post_batch(client, "run-trunc", lines[:2], final=final_hash(lines))
        self.assert_error(resp, 400, "final_hash_mismatch")
        self.assert_error(client.get("/api/runs/run-trunc"), 404, "run_not_found")

    def test_tampered_hash_leaves_nothing(self, client):
        lines = valid_batch()
        lines[1]["hash"] = "0" * 64
        resp = post_batch(client, "run-tamper", lines, final=lines[-1]["hash"])
        self.assert_error(resp, 400, "hash_mismatch")
        self.assert_error(client.get("/api/runs/run-tamper"), 404, "run_not_found")

    def test_tampered_prev_hash(self, client):
        lines = valid_batch()
        lines[1]["prevHash"] = ZERO_HASH
        resp = post_batch(client, "run-prev", lines, final=lines[-1]["hash"])
        self.assert_error(resp, 400, "prev_hash_mismatch")

    def test_first_prev_hash_not_zeros(self, client):
        lines = valid_batch([b"x"])
        lines[0]["prevHash"] = "1" * 64
        resp = post_batch(client, "run-first", lines, final=lines[-1]["hash"])
        self.assert_error(resp, 400, "prev_hash_mismatch")

    def test_sequence_gap(self, client):
        lines = valid_batch()
        lines[0]["sequence"] = 1
        resp = post_batch(client, "run-seq", lines, final=lines[-1]["hash"])
        self.assert_error(resp, 400, "sequence_mismatch")

    def test_invalid_base64(self, client):
        lines = valid_batch([b"x"])
        lines[0]["payload"] = "!!!"
        resp = post_batch(client, "run-b64", lines, final=lines[-1]["hash"])
        self.assert_error(resp, 400, "invalid_base64")

    def test_missing_final_hash_header(self, client):
        lines = valid_batch()
        resp = post_batch(client, "run-nofinal", lines)
        self.assert_error(resp, 400, "final_hash_missing")

    def test_wrong_final_hash(self, client):
        lines = valid_batch()
        resp = post_batch(client, "run-badfinal", lines, final="0" * 64)
        self.assert_error(resp, 400, "final_hash_mismatch")

    def test_empty_body(self, client):
        resp = client.post("/api/runs/run-empty", content=b"", headers={"X-Final-Hash": "0" * 64})
        self.assert_error(resp, 400, "empty_batch")

    def test_invalid_gzip(self, client):
        resp = client.post(
            "/api/runs/run-badgz",
            content=b"not gzip",
            headers={"Content-Encoding": "gzip", "X-Final-Hash": "0" * 64},
        )
        self.assert_error(resp, 400, "invalid_gzip")

    def test_unsupported_encoding(self, client):
        resp = client.post(
            "/api/runs/run-br",
            content=b"x",
            headers={"Content-Encoding": "br", "X-Final-Hash": "0" * 64},
        )
        self.assert_error(resp, 415, "unsupported_content_encoding")

    def test_too_many_lines(self, client):
        lines = valid_batch([b"x"] * 501)
        resp = post_batch(client, "run-many", lines, final=final_hash(lines))
        self.assert_error(resp, 400, "too_many_lines")

    def test_oversized_body_413(self, client):
        resp = client.post(
            "/api/runs/run-huge",
            content=b"x" * (3 * 1024 * 1024),
            headers={"X-Final-Hash": "0" * 64},
        )
        self.assert_error(resp, 413, "payload_too_large")

    def test_duplicate_run_409_and_original_kept(self, client):
        lines = valid_batch()
        assert post_batch(client, "run-dup", lines, final=final_hash(lines)).status_code == 201
        other = valid_batch([b"different"])
        resp = post_batch(client, "run-dup", other, final=final_hash(other))
        self.assert_error(resp, 409, "run_already_exists")
        assert client.get("/api/runs/run-dup").json()["lines"] == lines


class TestStorageGuarantees:
    def test_concurrent_same_run_only_one_commits(self, tmp_path):
        storage = Storage(str(tmp_path / "runs.db"))
        lines = []
        from app.validation import parse_and_validate

        for payloads in ([b"a", b"b"], [b"c", b"d"], [b"e", b"f"], [b"g", b"h"]):
            lines.append(parse_and_validate(encode_ndjson(build_lines(payloads))))

        results = []

        def commit(batch):
            try:
                storage.commit_run("run-race", batch)
                results.append("ok")
            except RunExistsError:
                results.append("exists")

        with ThreadPoolExecutor(max_workers=len(lines)) as pool:
            list(pool.map(commit, lines))

        assert results.count("ok") == 1
        assert results.count("exists") == len(lines) - 1
        run = storage.get_run("run-race")
        assert run is not None
        assert run["lineCount"] == 2

    def test_persistence_across_reopen(self, tmp_path):
        db = str(tmp_path / "runs.db")
        from app.validation import parse_and_validate

        batch = parse_and_validate(encode_ndjson(build_lines([b"persist", b"me"])))
        Storage(db).commit_run("run-persist", batch)

        # A brand-new Storage on the same file simulates a container restart.
        reopened = Storage(db)
        run = reopened.get_run("run-persist")
        assert run is not None
        assert run["lineCount"] == 2
        assert run["finalHash"] == batch[-1].hash
        assert [l["hash"] for l in run["lines"]] == [l.hash for l in batch]

        # The duplicate guard also survives the restart.
        with pytest.raises(RunExistsError):
            reopened.commit_run("run-persist", batch)

    def test_persistence_across_app_restart(self, tmp_path):
        db = str(tmp_path / "runs.db")
        lines = valid_batch([b"restart"])
        with TestClient(create_app(db)) as first:
            resp = post_batch(first, "run-restart", lines, final=final_hash(lines))
            assert resp.status_code == 201
        with TestClient(create_app(db)) as second:
            resp = second.get("/api/runs/run-restart")
            assert resp.status_code == 200
            assert resp.json()["lines"] == lines
            dup = post_batch(second, "run-restart", lines, final=final_hash(lines))
            assert dup.status_code == 409

    def test_failed_commit_leaves_nothing_queryable(self, tmp_path):
        db = str(tmp_path / "runs.db")
        with TestClient(create_app(db)) as client:
            lines = valid_batch([b"a", b"b", b"c"])
            resp = post_batch(client, "run-fail", lines[:1], final=final_hash(lines))
            assert resp.status_code == 400
            assert client.get("/api/runs/run-fail").status_code == 404
        # And nothing half-written survives even at the storage level.
        assert Storage(db).get_run("run-fail") is None
