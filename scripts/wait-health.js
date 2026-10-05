'use strict';

// Poll an API base URL until /healthz answers 200, or fail after a timeout.
// Usage: node wait-health.js [BASE_URL] [TIMEOUT_MS]

const base = process.argv[2] || process.env.API_BASE || 'http://127.0.0.1:8080';
const timeoutMs = Number(process.argv[3] || process.env.HEALTH_TIMEOUT_MS || 60000);
const deadline = Date.now() + timeoutMs;

async function wait() {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) {
        const body = await res.text();
        console.log(`API healthy after ${attempt} attempt(s): ${body.trim()}`);
        return;
      }
    } catch {
      // connection refused / server still starting
    }
    if (Date.now() > deadline) {
      console.error(`API at ${base} did not become healthy within ${timeoutMs} ms`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

wait();
