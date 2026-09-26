# syntax=docker/dockerfile:1
FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/anmolmathur/travel" \
      org.opencontainers.image.title="Wander" \
      org.opencontainers.image.description="Self-hosted flight logbook"
ENV NODE_ENV=production PORT=3000 WANDER_DB=/data/wander.db
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
