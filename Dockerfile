# Kairos — single-container deployment. No native modules; SQLite is built into Node.
FROM node:22-alpine AS build
WORKDIR /app
# pin pnpm to the version that produced pnpm-lock.yaml (corepack reads packageManager)
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 KAIROS_DB=/data/kairos.db
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate && mkdir -p /data
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/server/server/index.js"]
