"""Unit tests for the pure validation logic."""
import gzip

import pytest

from app import validation
from app.validation import (
    MAX_DECOMPRESSED_BYTES,
    MAX_LINES,
    ZERO_HASH,
    BatchError,
    decode_body,
    gunzip_limited,
    parse_and_validate,
    validate_final_hash,
)
from verify.chain import build_lines, encode_ndjson, final_hash


def make_batch(payloads=(b"a", b"b", b"c")):
    lines = build_lines(list(payloads))
    return lines, encode_ndjson(lines)


class TestParseAndValidate:
    def test_valid_batch(self):
        lines, raw = make_batch()
        parsed = parse_and_validate(raw)
        assert [l.sequence for l in parsed] == [0, 1, 2]
        assert [l.hash for l in parsed] == [l["hash"] for l in lines]
        assert parsed[0].prev_hash == ZERO_HASH

    def test_single_line_batch(self):
        lines, raw = make_batch([b"only"])
        parsed = parse_and_validate(raw)
        assert len(parsed) == 1

    def test_trailing_newline_tolerated_and_absorbed(self):
        lines, _ = make_batch()
        without_newline = encode_ndjson(lines).rstrip(b"\n")
        assert len(parse_and_validate(without_newline)) == len(lines)

    def test_extra_fields_are_ignored(self):
        lines, _ = make_batch([b"x"])
        lines[0]["instrument"] = "orbitrap"
        parsed = parse_and_validate(encode_ndjson(lines))
        assert len(parsed) == 1

    def test_empty_body(self):
        with pytest.raises(BatchError) as exc:
            parse_and_validate(b"")
        assert exc.value.code == "empty_batch"

    def test_only_newlines(self):
        with pytest.raises(BatchError) as exc:
            parse_and_validate(b"\n\n\n")
        assert exc.value.code == "empty_line"

    def test_blank_line_in_middle(self):
        lines, _ = make_batch()
        raw = encode_ndjson(lines[:1]) + b"\n" + encode_ndjson(lines[1:])
        with pytest.raises(BatchError) as exc:
            parse_and_validate(raw)
        assert exc.value.code == "empty_line"
        assert exc.value.details["line"] == 1

    def test_invalid_json(self):
        with pytest.raises(BatchError) as exc:
            parse_and_validate(b"{not json}\n")
        assert exc.value.code == "invalid_json"
        assert exc.value.details["line"] == 0

    def test_non_object_line(self):
        with pytest.raises(BatchError) as exc:
            parse_and_validate(b"[1, 2, 3]\n")
        assert exc.value.code == "invalid_line"

    def test_missing_field(self):
        lines, _ = make_batch([b"x"])
        del lines[0]["hash"]
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "missing_field"
        assert exc.value.details["field"] == "hash"

    def test_sequence_must_start_at_zero(self):
        lines, _ = make_batch([b"x"])
        lines[0]["sequence"] = 1
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "sequence_mismatch"
        assert exc.value.details == {"line": 0, "expected": 0, "actual": 1}

    def test_sequence_gap(self):
        lines, _ = make_batch()
        lines[2]["sequence"] = 7
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "sequence_mismatch"
        assert exc.value.details["line"] == 2

    def test_sequence_bool_rejected(self):
        lines, _ = make_batch([b"x"])
        lines[0]["sequence"] = True
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "invalid_field"

    def test_first_prev_hash_must_be_zeros(self):
        lines, _ = make_batch([b"x"])
        lines[0]["prevHash"] = "f" * 64
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "prev_hash_mismatch"
        assert exc.value.details["expected"] == ZERO_HASH

    def test_prev_hash_chain_break(self):
        lines, _ = make_batch()
        lines[1]["prevHash"] = ZERO_HASH
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "prev_hash_mismatch"
        assert exc.value.details["line"] == 1

    def test_hash_recomputed(self):
        lines, _ = make_batch()
        lines[1]["hash"] = "0" * 64
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "hash_mismatch"
        assert exc.value.details["line"] == 1
        assert exc.value.details["expected"] != "0" * 64

    def test_uppercase_hash_rejected(self):
        lines, _ = make_batch([b"x"])
        lines[0]["hash"] = lines[0]["hash"].upper()
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "invalid_field"

    def test_invalid_base64(self):
        lines, _ = make_batch([b"x"])
        lines[0]["payload"] = "!!!not-base64!!!"
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "invalid_base64"

    def test_too_many_lines(self):
        lines = build_lines([b"x"] * (MAX_LINES + 1))
        with pytest.raises(BatchError) as exc:
            parse_and_validate(encode_ndjson(lines))
        assert exc.value.code == "too_many_lines"
        assert exc.value.details["count"] == MAX_LINES + 1

    def test_exactly_max_lines_ok(self):
        lines = build_lines([b"x"] * MAX_LINES)
        assert len(parse_and_validate(encode_ndjson(lines))) == MAX_LINES


class TestFinalHash:
    def test_matching_final_hash(self):
        lines, raw = make_batch()
        parsed = parse_and_validate(raw)
        assert validate_final_hash(parsed, final_hash(lines)) == final_hash(lines)

    def test_missing_header(self):
        _, raw = make_batch()
        parsed = parse_and_validate(raw)
        with pytest.raises(BatchError) as exc:
            validate_final_hash(parsed, None)
        assert exc.value.code == "final_hash_missing"

    def test_truncated_batch_fails_final_hash(self):
        # Simulates a crash mid-batch: a valid prefix whose committed
        # final hash belongs to a line that never arrived.
        lines, _ = make_batch([b"a", b"b", b"c", b"d"])
        parsed = parse_and_validate(encode_ndjson(lines[:2]))
        with pytest.raises(BatchError) as exc:
            validate_final_hash(parsed, final_hash(lines))
        assert exc.value.code == "final_hash_mismatch"
        assert exc.value.details["expected"] == parsed[-1].hash

    def test_malformed_header(self):
        _, raw = make_batch()
        parsed = parse_and_validate(raw)
        with pytest.raises(BatchError) as exc:
            validate_final_hash(parsed, "not-a-hash")
        assert exc.value.code == "invalid_final_hash"


class TestBodyDecoding:
    def test_plain_passthrough(self):
        assert decode_body(b"line\n", None) == b"line\n"
        assert decode_body(b"line\n", "identity") == b"line\n"

    def test_gzip_roundtrip(self):
        raw = b'{"sequence": 0}\n'
        assert decode_body(gzip.compress(raw), "gzip") == raw

    def test_gzip_magic_sniffed_without_header(self):
        raw = b'{"sequence": 0}\n'
        assert decode_body(gzip.compress(raw), None) == raw

    def test_invalid_gzip(self):
        with pytest.raises(BatchError) as exc:
            decode_body(b"definitely not gzip", "gzip")
        assert exc.value.code == "invalid_gzip"

    def test_truncated_gzip(self):
        blob = gzip.compress(b"x" * 1000)[:10]
        with pytest.raises(BatchError) as exc:
            decode_body(blob, "gzip")
        assert exc.value.code == "invalid_gzip"

    def test_unsupported_encoding(self):
        with pytest.raises(BatchError) as exc:
            decode_body(b"x", "br")
        assert exc.value.code == "unsupported_content_encoding"
        assert exc.value.status == 415

    def test_plain_body_size_limit(self, monkeypatch):
        monkeypatch.setattr(validation, "MAX_DECOMPRESSED_BYTES", 16)
        with pytest.raises(BatchError) as exc:
            decode_body(b"x" * 17, None)
        assert exc.value.code == "payload_too_large"
        assert exc.value.status == 413

    def test_gzip_bomb_stopped_at_limit(self):
        blob = gzip.compress(b"x" * (MAX_DECOMPRESSED_BYTES + 1))
        with pytest.raises(BatchError) as exc:
            gunzip_limited(blob)
        assert exc.value.code == "payload_too_large"
        assert exc.value.status == 413

    def test_gzip_exactly_at_limit_ok(self):
        raw = b"x" * MAX_DECOMPRESSED_BYTES
        assert gunzip_limited(gzip.compress(raw)) == raw
