FROM node:26-slim

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=$NPM_REGISTRY \
    COREPACK_NPM_REGISTRY=$NPM_REGISTRY

RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production \
    PORT=8787 \
    AGENTSHARE_DATA=/data

EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "packages/registry/dist/server.js"]
