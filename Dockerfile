FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG VITE_CLERK_PUBLISHABLE_KEY
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY convex/ convex/
COPY server/ server/
COPY frontend/ frontend/
RUN pnpm build && pnpm prune --prod

FROM debian:bookworm-slim AS bubblewrap-build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl libcap-dev meson ninja-build pkg-config xz-utils && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/bubblewrap-0.12.0.tar.xz https://github.com/containers/bubblewrap/releases/download/v0.12.0/bubblewrap-0.12.0.tar.xz \
    && echo '9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314  /tmp/bubblewrap-0.12.0.tar.xz' | sha256sum -c - \
    && tar -xf /tmp/bubblewrap-0.12.0.tar.xz -C /tmp
RUN meson setup /tmp/bubblewrap-build /tmp/bubblewrap-0.12.0 --prefix=/usr \
    -Dselinux=disabled -Dtests=false -Dbash_completion=disabled -Dzsh_completion=disabled -Dman=disabled \
    && meson compile -C /tmp/bubblewrap-build \
    && DESTDIR=/tmp/bubblewrap-install meson install -C /tmp/bubblewrap-build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libcap2 python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY --from=bubblewrap-build /tmp/bubblewrap-install/usr/bin/bwrap /usr/bin/bwrap
WORKDIR /app
COPY requirements.txt ./
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -r requirements.txt
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV NODE_ENV=production
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/
COPY --from=build /app/frontend/dist/ frontend/dist/
COPY problems/ problems/
USER node
EXPOSE 8000
CMD ["node", "--max-old-space-size=256", "--max-semi-space-size=8", "dist/server/index.js"]
