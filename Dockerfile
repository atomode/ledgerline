# syntax=docker/dockerfile:1.7
#
# One Dockerfile, three deployable targets:
#   docker build --target api     -t ledgerline-api .
#   docker build --target worker  -t ledgerline-worker .
#   docker build --target migrate -t ledgerline-migrate .   # run to completion before rolling apps
#
# Build stage: full pnpm workspace, compile everything, then `pnpm deploy --prod` copies each app
# with only its production dependencies (workspace packages included as built copies).
# Runtime stage: distroless Node 22, non-root, no shell, no package manager.

ARG NODE_VERSION=22.20.0
# Stamped into the OTel resource as service.version (release.yml passes the commit sha).
ARG SERVICE_VERSION=dev

FROM node:${NODE_VERSION}-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
WORKDIR /repo
# Optional: builds behind a TLS-intercepting proxy pass its CA with
#   --secret id=extra_ca,src=/path/to/ca.pem   (never baked into a layer)
ENV NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca
# Lockfile first: `pnpm fetch` only depends on it, so source edits keep this layer cached.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    corepack enable && pnpm fetch
COPY . .
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
 && pnpm exec turbo run build --filter=@ledgerline/api... --filter=@ledgerline/worker... --filter=@ledgerline/db... \
 && pnpm --filter @ledgerline/api deploy --prod --legacy /out/api \
 && pnpm --filter @ledgerline/worker deploy --prod --legacy /out/worker \
 && pnpm --filter @ledgerline/db deploy --prod --legacy /out/migrate \
 && rm -rf /out/*/src /out/*/test /out/*/scripts \
 && find /out \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -delete

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
ARG SERVICE_VERSION
ENV NODE_ENV=production SERVICE_VERSION=${SERVICE_VERSION}
WORKDIR /app

FROM runtime AS api
COPY --from=build --chown=nonroot:nonroot /out/api /app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENV OTEL_SERVICE_NAME=ledgerline-api
# --import loads the OpenTelemetry SDK before the app's first import (required for ESM patching).
CMD ["--import", "@ledgerline/observability/register", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=nonroot:nonroot /out/worker /app
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "dist/healthcheck.js"]
ENV OTEL_SERVICE_NAME=ledgerline-worker
CMD ["--import", "@ledgerline/observability/register", "dist/main.js"]

FROM runtime AS migrate
COPY --from=build --chown=nonroot:nonroot /out/migrate /app
CMD ["dist/bin/migrate.js"]
