# The edge: HTTPS in front of workspaces that run on machines of their own. It needs nothing but
# Node, so the image is Node and the compiled program.
# Build from the repository root:  docker build -f apps/edge/Dockerfile -t hive-edge .
#
# It runs as `node` and listens on 443 and 80, which Docker allows a container's processes by
# default, so publish them:  docker run -p 443:443 -p 80:80 …

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
RUN npm install --global pnpm@11.19.0
ENV CI=true
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mobile/package.json apps/mobile/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter .
COPY tsconfig.json tsconfig.build.json ./
COPY apps/edge apps/edge
RUN pnpm exec tsc -p tsconfig.build.json

FROM ${NODE_IMAGE} AS edge
WORKDIR /app
COPY --from=build /src/dist ./dist
USER node
ENV NODE_ENV=production
EXPOSE 80 443
CMD ["node", "dist/apps/edge/src/index.js"]
