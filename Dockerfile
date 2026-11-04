# Untested on real hardware. Software encoding by default (VIDEO_ENCODER=libx264).
FROM node:24-bookworm-slim

# ffmpeg from Debian; fonts-dejavu-core gives drawtext (the next-episode countdown) a font
# via fontconfig, because src/ffmpeg.js only names a font file on Windows.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Standalone yt-dlp binary (no Python needed). It updates itself (yt-dlp -U), so the
# runtime user must own it. TARGETARCH is set by BuildKit.
ARG TARGETARCH
RUN mkdir -p /app/tools /app/data /app/tmp \
 && case "${TARGETARCH:-amd64}" in \
      arm64) YTDLP=yt-dlp_linux_aarch64 ;; \
      *) YTDLP=yt-dlp_linux ;; \
    esac \
 && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP}" -o /app/tools/yt-dlp \
 && chmod +x /app/tools/yt-dlp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
COPY tools/doctor.mjs ./tools/doctor.mjs

# The node image already has an unprivileged user "node" (uid 1000).
RUN chown -R node:node /app/data /app/tmp /app/tools
USER node

ENV NODE_ENV=production \
    YTDLP_PATH=/app/tools/yt-dlp \
    VIDEO_ENCODER=libx264 \
    HW_DECODE=0

VOLUME /app/data
CMD ["node", "index.js"]
