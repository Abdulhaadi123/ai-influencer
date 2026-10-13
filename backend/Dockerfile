# ─────────────────────────────────────────────────────────────────────────────
# One image, two entrypoints: the API server and the generation worker.
# docker-compose runs both from this image with different commands, so they can
# never drift out of sync with each other or with the endpoint code.
#
# The build context is this folder, so the mobile app and web UI are not part
# of the image and are not even sent to the Docker daemon.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# ffmpeg (with ffprobe) pulls frames out of videos so content moderation can check
# them (api/_lib/moderation/frames.js). Installed before the user is dropped, and
# before the code is copied, so it stays in its own cached layer.
RUN apk add --no-cache ffmpeg

# Dependencies first, so a code change does not invalidate the install layer.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY api ./api
COPY lib ./lib
COPY server ./server
COPY db ./db

# Never run as root. A container escape from a process holding the AWS keys and
# the database password is bad enough without it starting as root.
USER node

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server/index.js"]
