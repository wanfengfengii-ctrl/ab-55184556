"""One-shot verification service.

Waits for the API to become healthy, then runs, in order:
  1. a compile check of all Python sources (the "build" step),
  2. the unit/integration test suite (pytest),
  3. plaintext and gzip smoke tests against the live API.

Exits 0 only if every step succeeds, so
``docker compose up --exit-code-from verify`` reflects the result.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.request

HEALTH_TIMEOUT_SECONDS = 180


def wait_for_health(base: str, timeout: float = HEALTH_TIMEOUT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            with urllib.request.urlopen(base + "/health", timeout=5) as resp:
                if resp.status == 200:
                    print(f"[verify] API healthy at {base} (attempt {attempt})", flush=True)
                    return True
        except Exception as exc:  # noqa: BLE001 - keep polling until the deadline
            print(f"[verify] waiting for API health ({exc})", flush=True)
        time.sleep(2)
    print(f"[verify] API at {base} did not become healthy within {timeout}s", flush=True)
    return False


def _run_step(name: str, cmd: list[str]) -> int:
    print(f"[verify] step {name!r}: {' '.join(cmd)}", flush=True)
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        print(f"[verify] step {name!r} failed with exit code {result.returncode}", flush=True)
    return result.returncode


def main() -> int:
    base = os.environ.get("API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")

    if not wait_for_health(base):
        return 1

    rc = _run_step(
        "compile", [sys.executable, "-m", "compileall", "-q", "app", "verify", "tests"]
    )
    if rc != 0:
        return rc

    rc = _run_step("unit-tests", [sys.executable, "-m", "pytest", "-q", "tests"])
    if rc != 0:
        return rc

    from verify.smoke import run_smoke

    if not run_smoke(base):
        return 1

    print("[verify] all verification steps succeeded", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
