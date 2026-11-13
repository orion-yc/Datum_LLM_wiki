FROM node:24-bookworm-slim AS web-build
WORKDIR /web
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.mjs ./
COPY public ./public
COPY src ./src
RUN pnpm build

FROM debian:bookworm-slim AS cpp-build
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake g++ make qt6-base-dev libssl-dev tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY CMakeLists.txt ./
COPY backend ./backend
RUN cmake -S . -B /build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /build --parallel 2 \
    && ctest --test-dir /build --output-on-failure

FROM debian:bookworm-slim AS runtime
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    libqt6core6 libqt6network6 libqt6sql6-sqlite libssl3 \
    poppler-utils poppler-data ca-certificates tzdata curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 datum && useradd --uid 1000 --gid datum --no-create-home datum
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3001 DATA_DIR=/app/data STATIC_DIR=/app/dist APP_TIMEZONE=Asia/Shanghai
COPY --from=cpp-build /build/datum-server /app/datum-server
COPY --from=web-build /web/dist /app/dist
RUN mkdir -p /app/data && chown datum:datum /app/data
USER datum
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent --max-time 4 http://127.0.0.1:3001/api/health > /dev/null || exit 1
CMD ["/app/datum-server"]
