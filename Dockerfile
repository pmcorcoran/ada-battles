# ── Build stage ────────────────────────────────────────────────────
#
# Compile both server entrypoints (matchmaker + runner) and the client
# bundle. The image we ship at the end carries only the compiled output
# and production deps — no TS toolchain, no source.
#
# Post-refactor layout: backend/, frontend/, and shared/ are siblings
# at the repo root. Build context is the repo root (see compose).
#
FROM node:20-alpine AS build

WORKDIR /app

# Install backend and frontend deps separately. Layer caching: package
# manifests change rarely; source changes constantly. Copy manifests
# first, install, then copy source.
COPY backend/package.json backend/package-lock.json* ./backend/
COPY frontend/package.json frontend/package-lock.json* ./frontend/

RUN cd backend  && npm ci
RUN cd frontend && npm ci

# Source. shared/ is consumed by both sides via the @shared/* path
# alias in each tsconfig.
COPY shared/   ./shared/
COPY backend/  ./backend/
COPY frontend/ ./frontend/

# Build server (TSC → backend/dist/) and client bundle
# (esbuild → frontend/public/bundle.js).
RUN cd backend  && npm run build
RUN cd frontend && npm run build

# Prune dev deps so the runtime layer copies a slim node_modules.
# Only the backend's node_modules ships — the frontend's deps are
# bundled into the client bundle by esbuild and don't need to exist
# at runtime.
RUN cd backend && npm prune --omit=dev


# ── Runtime stage ──────────────────────────────────────────────────
#
# Same image is used for the matchmaker AND the lobby-runner. The
# difference is purely the Cmd: matchmaker/index.js or runner.js. This
# keeps CI simple — one build, one image, two roles.
#
FROM node:20-alpine AS runtime

# GID of the docker group on the host machine. Override at build time
# with: docker compose build --build-arg DOCKER_GID=$(getent group docker | cut -d: -f3)
ARG DOCKER_GID=984

RUN apk add --no-cache dumb-init && \
    addgroup -g ${DOCKER_GID} docker && \
    addgroup -S app && \
    adduser -S app -G app && \
    addgroup app docker

WORKDIR /app

# Compiled JS, production deps, and the static client bundle.
#
# Note on the dist/ path: because backend/tsconfig.json includes
# files from ../shared, tsc emits with rootDir set to the repo root,
# producing dist/backend/src/... and dist/shared/.... The CMD below
# reflects that. If you ever flatten this, the spawn override in
# DockerOrchestrator must change in lockstep.
COPY --from=build --chown=app:app /app/backend/node_modules    ./node_modules
COPY --from=build --chown=app:app /app/backend/dist            ./dist
COPY --from=build --chown=app:app /app/frontend/public         ./public

# Either service listens on $PORT; matchmaker defaults to 8080, runner
# to 3000, but both honour the env var. We don't EXPOSE here — the
# compose / k8s manifest declares ports per-service.

USER app

# dumb-init reaps zombies and forwards SIGTERM correctly to node, which
# matters because the runner self-exits on idle and we don't want
# orphaned processes lingering inside the container.
ENTRYPOINT ["dumb-init", "--"]

# Default is the matchmaker; runner containers override Cmd at spawn
# time (see DockerOrchestrator.spawn in backend/src/matchmaker/orchestrator/).
CMD ["node", "dist/backend/src/matchmaker/index.js"]