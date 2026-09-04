# One image, three services. api, inventory and worker share a workspace build
# and differ only by the command docker-compose gives them, which keeps build
# time down and guarantees the three of them run identical dependency trees.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY packages/domain/package.json    packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/otel/package.json      packages/otel/
COPY packages/platform/package.json  packages/platform/
COPY apps/api/package.json           apps/api/
COPY apps/inventory/package.json     apps/inventory/
COPY apps/worker/package.json        apps/worker/
COPY apps/web/package.json           apps/web/
COPY e2e/package.json                e2e/
RUN npm install --workspaces --include-workspace-root --omit=optional --ignore-scripts

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/inventory apps/inventory
COPY apps/worker apps/worker
RUN npm run build --workspace=@ticketing/domain \
 && npm run build --workspace=@ticketing/contracts \
 && npm run build --workspace=@ticketing/otel \
 && npm run build --workspace=@ticketing/platform \
 && npm run build --workspace=@ticketing/api \
 && npm run build --workspace=@ticketing/inventory \
 && npm run build --workspace=@ticketing/worker

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl tini
ENV NODE_ENV=production
# Loaded via --require so instrumentation is registered before any application
# module is imported. Patching after the fact silently produces empty traces.
ENV NODE_OPTIONS=--require=/app/packages/otel/dist/register.js

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/apps/api/dist       apps/api/dist
COPY --from=build /app/apps/inventory/dist apps/inventory/dist
COPY --from=build /app/apps/worker/dist    apps/worker/dist
COPY --from=build /app/apps/api/package.json       apps/api/package.json
COPY --from=build /app/apps/inventory/package.json apps/inventory/package.json
COPY --from=build /app/apps/worker/package.json    apps/worker/package.json
COPY package.json ./
COPY db db
COPY scripts scripts

USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
