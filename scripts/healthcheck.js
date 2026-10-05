'use strict';

// Container health probe: GET /healthz, exit non-zero on any failure.
const port = process.env.PORT || 8080;
const host = process.env.HEALTH_HOST || '127.0.0.1';
const url = `http://${host}:${port}/healthz`;

fetch(url)
  .then((res) => {
    if (!res.ok) {
      console.error(`healthcheck ${url} returned ${res.status}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(`healthcheck ${url} failed: ${err.message}`);
    process.exit(1);
  });
