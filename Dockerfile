# Ein Prozess, keine Build-Schritte, kein Webserver im Container.
# TLS und Domain macht der Coolify-Proxy davor.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# better-sqlite3 bringt fertige Binaerdateien mit; falls nicht, wird hier gebaut.
COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY public ./public

EXPOSE 3000
CMD ["node", "src/server.js"]
