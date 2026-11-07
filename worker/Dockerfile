# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
# Public environment CA is a build-only mount, never copied into image layers.
RUN --mount=type=secret,id=proxy_ca,mode=0444,target=/tmp/proxy-ca.pem \
    if [ -s /tmp/proxy-ca.pem ]; then export SSL_CERT_FILE=/tmp/proxy-ca.pem; fi; \
    apk add --no-cache ffmpeg ca-certificates
WORKDIR /app
COPY --chown=node:node . .
# Root .dockerignore includes only reviewed worker and shared JavaScript modules.
ENV NODE_ENV=production STUDIO_WORKER_EXECUTION_ENABLED=false
USER node
ENTRYPOINT ["node","worker/runtime/main.mjs"]
