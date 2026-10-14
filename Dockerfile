FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git gosu ripgrep tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 dsh \
  && useradd --uid 10001 --gid dsh --create-home --shell /bin/bash dsh

WORKDIR /app

COPY package.json package-lock.json patch-upstream.mjs ./
RUN npm ci --omit=dev --ignore-scripts=false \
  && node patch-upstream.mjs \
  && npm cache clean --force

COPY gateway.mjs entrypoint.sh railway.patch.yml LICENSE ./
RUN chmod 0755 /app/entrypoint.sh \
  && sh -n /app/entrypoint.sh \
  && node --check /app/gateway.mjs \
  && mkdir -p /data \
  && chown dsh:dsh /data

ENV NODE_ENV=production \
  HOME=/home/dsh \
  DSH_HOME=/data/.dsh \
  WORKSPACE_DIR=/data/workspace \
  DSH_TELEMETRY_DISABLED=true

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
