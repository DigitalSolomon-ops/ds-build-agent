# ds-build-agent harness + dashboard, deployed as `ds-dashboard` in the
# n8n-stack compose on the GCP VM. Two stages so the runtime image carries
# only production deps (agent SDK + yaml), not typescript/playwright.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc

FROM node:22-bookworm-slim
# git: the orchestrator commits build folders after each task.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY dashboard/public ./dashboard/public
ENV DS_DASHBOARD_HOST=0.0.0.0
EXPOSE 4317
CMD ["node", "dist/dashboard/server.js"]
