FROM node:22-alpine AS builder
WORKDIR /app

# bun
RUN corepack enable && corepack prepare bun@latest --activate

COPY bun.lockb package.json ./
RUN bun install --frozen-lockfile

COPY . .

RUN bunx prisma generate

RUN bun run build


FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare bun@latest --activate

COPY bun.lockb package.json ./
RUN bun install --production --frozen-lockfile

COPY prisma ./prisma

COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/main"]