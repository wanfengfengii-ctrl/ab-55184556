"""HTTP API for the spectra archive.

Endpoints:
  POST /api/runs/{runId}  — commit a whole batch (NDJSON, optional gzip)
  GET  /api/runs/{runId}  — read back a committed batch, in order
  GET  /health            — liveness/readiness probe

Every failure, expected or not, is answered with a stable structured
body: ``{"error": {"code": ..., "message": ..., "details": {...}}}``.
"""
from __future__ import annotations

import os
import re

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.storage import RunExistsError, Storage
from app.validation import (
    MAX_COMPRESSED_BYTES,
    BatchError,
    decode_body,
    parse_and_validate,
    validate_final_hash,
)

RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _error_response(status: int, code: str, message: str, details: dict) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={
            "error": {"code": code, "message": message, "details": details or {}}
        },
    )


def _check_run_id(run_id: str) -> None:
    if not RUN_ID_PATTERN.match(run_id):
        raise BatchError(
            "invalid_run_id",
            "run id must be 1-128 characters of [A-Za-z0-9._-] "
            "and start with a letter or digit",
            details={"runId": run_id},
        )


def create_app(db_path: str | None = None) -> FastAPI:
    if db_path is None:
        db_path = os.environ.get("DATABASE_PATH") or os.path.join(
            os.environ.get("DATA_DIR", "./data"), "runs.db"
        )
    storage = Storage(db_path)

    app = FastAPI(
        title="Spectra Archive",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.storage = storage

    @app.exception_handler(BatchError)
    async def batch_error_handler(_request: Request, exc: BatchError) -> JSONResponse:
        return _error_response(exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(
        _request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        code = {
            404: "not_found",
            405: "method_not_allowed",
        }.get(exc.status_code, f"http_{exc.status_code}")
        return _error_response(exc.status_code, code, str(exc.detail), {})

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return _error_response(
            422, "invalid_request", "request validation failed", {"errors": exc.errors()}
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
        return _error_response(500, "internal_error", "internal server error", {})

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok"}

    @app.post("/api/runs/{run_id}", status_code=201)
    async def create_run(run_id: str, request: Request) -> JSONResponse:
        _check_run_id(run_id)

        # Reject obviously oversized bodies before reading them in full.
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                declared = int(content_length)
            except ValueError:
                declared = None
            if declared is not None and declared > MAX_COMPRESSED_BYTES:
                raise BatchError(
                    "payload_too_large",
                    "request body is too large to be a legal batch",
                    status=413,
                    details={"limit": MAX_COMPRESSED_BYTES},
                )

        body = await request.body()
        data = decode_body(body, request.headers.get("content-encoding"))
        lines = parse_and_validate(data)
        final_hash = validate_final_hash(lines, request.headers.get("x-final-hash"))

        try:
            storage.commit_run(run_id, lines)
        except RunExistsError:
            raise BatchError(
                "run_already_exists",
                f"run {run_id!r} has already been committed",
                status=409,
                details={"runId": run_id},
            ) from None

        return JSONResponse(
            status_code=201,
            headers={"Location": f"/api/runs/{run_id}"},
            content={
                "runId": run_id,
                "committed": True,
                "lineCount": len(lines),
                "finalHash": final_hash,
            },
        )

    @app.get("/api/runs/{run_id}")
    async def get_run(run_id: str) -> dict:
        _check_run_id(run_id)
        run = storage.get_run(run_id)
        if run is None:
            raise BatchError(
                "run_not_found",
                f"run {run_id!r} does not exist",
                status=404,
                details={"runId": run_id},
            )
        return run

    return app


app = create_app()
