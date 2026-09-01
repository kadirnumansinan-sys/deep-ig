# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Europe/Istanbul
ENV NODE_OPTIONS=--experimental-sqlite

RUN addgroup --system --gid 1001 deepbrief \
  && adduser --system --uid 1001 --ingroup deepbrief deepbrief \
  && mkdir -p /data \
  && chown deepbrief:deepbrief /data

COPY --from=builder --chown=deepbrief:deepbrief /app/.next ./.next
COPY --from=builder --chown=deepbrief:deepbrief /app/node_modules ./node_modules
COPY --from=builder --chown=deepbrief:deepbrief /app/package.json ./package.json

USER deepbrief
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["npm", "run", "start", "--", "--port", "3000"]
