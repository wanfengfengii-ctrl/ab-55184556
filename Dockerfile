# syntax=docker/dockerfile:1

# Node 22 on Alpine: the application uses only Node built-ins
# (http, crypto, zlib, fs) so there are no npm dependencies to install.
FROM node:22-alpine

WORKDIR /app

# Application sources and test/verification scripts.
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test

RUN chmod +x scripts/verify.sh \
    && mkdir -p /data \
    && chown -R node:node /data /app

USER node

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

EXPOSE 8080

# Image-level health check (also referenced by compose).
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node scripts/healthcheck.js

CMD ["node", "src/server.js"]
