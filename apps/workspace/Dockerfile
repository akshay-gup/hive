# A workspace: the Hive server and the agent it works through, as one machine.
# Build from the repository root:  docker build -f apps/workspace/Dockerfile -t hive-workspace .

ARG NODE_IMAGE=node:22-bookworm-slim
ARG BASE_IMAGE=ubuntu:24.04

# The agent. Its version is the one the server's SDK is pinned to, which tests/workspace-image.test.ts checks.
FROM ${NODE_IMAGE} AS agent
ARG OPENCODE_VERSION=1.18.33
# The x86-64 build that needs no AVX2, since the machine this runs on is not the one that builds it.
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) package=opencode-linux-x64-baseline ;; \
      aarch64) package=opencode-linux-arm64 ;; \
      *) echo "No OpenCode build for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    npm install --prefix /opt/agent --no-audit --no-fund "${package}@${OPENCODE_VERSION}"; \
    install -D -m 0755 "/opt/agent/node_modules/${package}/bin/opencode" /out/opencode; \
    /out/opencode --version

# The server, compiled, and only the packages it runs on.
FROM ${NODE_IMAGE} AS build
RUN npm install --global pnpm@11.19.0
# CI so that pnpm, when it drops the build's packages for the last step, does not ask first.
ENV CI=true
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mobile/package.json apps/mobile/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter .
COPY tsconfig.json tsconfig.build.json ./
COPY apps/server apps/server
COPY apps/control apps/control
COPY apps/workspace apps/workspace
COPY packages packages
RUN pnpm build:server && pnpm install --frozen-lockfile --filter . --prod

FROM ${BASE_IMAGE} AS workspace
ARG DEBIAN_FRONTEND=noninteractive
# What the agent finds on its machine: the tools a shell session reaches for.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq python3 ripgrep tini unzip \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=agent /out/opencode /usr/local/bin/opencode
RUN groupadd --gid 10001 hive \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/hive --shell /usr/sbin/nologin hive
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# Which build this is, for /api/health and for an updater that compares versions.
ARG HIVE_VERSION=dev
RUN printf "%s\n" "$HIVE_VERSION" > /app/VERSION
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data/hive \
    VOLUME_DIR=/data \
    WORKSPACE_UID=10001 \
    WORKSPACE_GID=10001 \
    WORKSPACE_HOME=/home/hive
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "dist/apps/workspace/src/index.js"]
