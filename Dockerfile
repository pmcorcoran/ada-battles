# ── Build stage ────────────────────────────────────────────────────
#
# Compile both server entrypoints (matchmaker + runner) and the client
# bundle. The image we ship at the end carries only the compiled output
# and production deps — no TS toolchain, no source.
#
FROM node:20-alpine AS build

WORKDIR /app

# Install build deps first so layer caching kicks in when only source
# changes. `frontend/` is the existing project root in the repo; the
# matchmaker.ts and runner.ts files live alongside it after the split.
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

# Source. The build needs everything under frontend/src plus the new
# entrypoints. `tsconfig.json` already covers all of these.
COPY frontend/tsconfig.json ./
COPY frontend/src ./src
COPY frontend/public ./public

# Build server (TSC → dist/) and client bundle (esbuild → public/bundle.js).
RUN npm run build

# Prune dev deps so the runtime layer copies a slim node_modules.
RUN npm prune --omit=dev


# ── Runtime stage ──────────────────────────────────────────────────
#
# Same image is used for the matchmaker AND the lobby-runner. The
# difference is purely the Cmd: matchmaker.js or runner.js. This keeps
# CI simple — one build, one image, two roles.
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
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist         ./dist
COPY --from=build --chown=app:app /app/public       ./public

# Either service listens on $PORT; matchmaker defaults to 8080, runner
# to 3000, but both honour the env var. We don't EXPOSE here — the
# compose / k8s manifest declares ports per-service.

USER app

# dumb-init reaps zombies and forwards SIGTERM correctly to node, which
# matters because the runner self-exits on idle and we don't want
# orphaned processes lingering inside the container.
ENTRYPOINT ["dumb-init", "--"]

# Default is the matchmaker; runner containers override Cmd at spawn
# time (see DockerOrchestrator.spawn in matchmaker.ts).
CMD ["node", "dist/server/matchmaker.js"]