FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS deps
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 WRANGLER_SEND_METRICS=false
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Build the portable JS on the builder's CPU. Keep both locked workerd optional dependencies
# available so amd64 and arm64 images reuse the same expensive compilation layers.
RUN printf '\nsupportedArchitectures:\n  os: [linux]\n  cpu: [x64, arm64]\n  libc: [glibc]\n' >> pnpm-workspace.yaml \
    && corepack enable && pnpm fetch --frozen-lockfile

FROM deps AS source
COPY tsconfig.json vite.config.ts ./
COPY packages/ packages/
COPY scripts/ scripts/
COPY docker/azure-network.mjs docker/model-transport.mjs docker/
RUN pnpm install --offline --frozen-lockfile

FROM source AS web-build
ARG OS_DASHBOARD_PORT=
RUN VITE_OS_DASHBOARD_PORT="$OS_DASHBOARD_PORT" VITE_CF_ACCESS_MODE=false pnpm exec vp run --no-cache -F @gadgets/workshop-frontend build:assets

FROM nginxinc/nginx-unprivileged:stable-alpine AS web
COPY docker/web.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /src/packages/workshop-frontend/dist/ /usr/share/nginx/html/
EXPOSE 8080

FROM source AS core-workers
ARG VP_RUN_CONCURRENCY_LIMIT=2
COPY docker/build-workers.mjs docker/
RUN node docker/build-workers.mjs /out core

FROM core-workers AS worker-build
RUN node docker/build-workers.mjs /out optional

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS runtime-files
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && test -s /etc/ssl/certs/ca-certificates.crt && flock --version \
    && install -d -m 0700 /volume-root/data /volume-root/os-dashboard-audit

FROM node:24-bookworm-slim AS workshop
ARG TARGETARCH
ENV NODE_ENV=production
WORKDIR /app
COPY --from=runtime-files /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=runtime-files --chown=1000:1000 /volume-root/ /
COPY --from=worker-build /out/native/${TARGETARCH}/workerd /usr/local/bin/workerd
COPY --from=worker-build /out/workers/ ./workers/
COPY --from=worker-build /out/storage/ ./storage/
COPY docker/workshop.mjs docker/model-transport.mjs docker/azure-network.mjs ./docker/
COPY docker/os-dashboard-export/*.mjs /os-dashboard-export/
COPY packages/workshop-shared/src/model-api-root.ts ./packages/workshop-shared/src/
USER node
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["node", "/app/docker/workshop.mjs"]
