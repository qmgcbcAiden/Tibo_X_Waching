FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DATA_DIR=/app/data \
    TZ=Asia/Shanghai
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app/data
USER pwuser
HEALTHCHECK --interval=5m --timeout=10s --start-period=2m --retries=3 \
  CMD ["node", "dist/src/healthcheck.js"]
CMD ["xvfb-run", "-a", "node", "dist/src/main.js"]
