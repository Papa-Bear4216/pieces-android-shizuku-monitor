# Build context must be the pieces-android repo ROOT, not this directory,
# so this Dockerfile can reach packages/allowlist. In docker-compose.yml this
# is expressed as: build: { context: ./pieces-android, dockerfile: apps/pieces-gateway/Dockerfile }

FROM node:22-slim

WORKDIR /app

COPY packages/allowlist /packages/allowlist
COPY apps/pieces-gateway/package.json ./
RUN npm install
COPY apps/pieces-gateway/src ./src

# devices.json persists via a mounted volume in docker-compose.yml - do not
# bake it into the image, it holds real device enrollment state.
ENV DEVICE_REGISTRY_PATH=/data/devices.json

EXPOSE 8788

CMD ["npx", "tsx", "src/server.ts"]
