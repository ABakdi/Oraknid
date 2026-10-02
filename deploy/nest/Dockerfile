# The Nest (ADR-018): the relay and its loader, built from the monorepo.
# Build from the repository root:  docker build -f deploy/nest/Dockerfile -t oraknid-nest .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter @oraknid/nest... \
 && pnpm --filter @oraknid/nest build \
 && pnpm --filter @oraknid/nest deploy --prod /out \
 && cp -r apps/nest/dist apps/nest/public /out/

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 NEST_DATA_DIR=/data
WORKDIR /app
COPY --from=build /out /app
# A public Nest keeps its registered daemons here (ADR-031): mount a volume on it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
