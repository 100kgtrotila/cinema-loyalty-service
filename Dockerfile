FROM node:22-alpine AS bun-base
COPY --from=oven/bun:1.3.13-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

FROM bun-base AS builder
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun x --no-install prisma generate
RUN bun run build

FROM bun-base AS runner
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --production
COPY --from=builder --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
