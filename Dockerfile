# The Sooner worker: polls the job boards that are due and records what changed.
#
#   docker build --tag sooner-worker .
#   docker run --env DATABASE_URL=... --env HR_CONTACT=... sooner-worker
#   docker run --env DATABASE_URL=... sooner-worker node dist/migrate.mjs      (the migration step, run before a new release)
#
# Two stages. The first installs everything and bundles the worker and the migration runner into two files; the second
# is just Node and those two files, so the image has no node_modules, no source and no build tools in it.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN node scripts/build-worker.ts

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# The base image's unprivileged user. The worker writes nothing to disk.
USER node
# SIGTERM (what a deploy sends) makes the worker finish the polls in flight and give its leases back. Give the platform
# at least SHUTDOWN_GRACE_SEC plus ten seconds to wait for it.
CMD ["node", "--enable-source-maps", "dist/worker.mjs"]
