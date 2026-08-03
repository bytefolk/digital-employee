FROM node:24-alpine AS build

WORKDIR /app

COPY --chown=node:node package.json package-lock.json .npmrc ./
COPY --chown=node:node packages/core/package.json ./packages/core/package.json
RUN npm ci --ignore-scripts

COPY --chown=node:node . .
RUN npm run build

FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json .npmrc ./
COPY --chown=node:node packages/core/package.json ./packages/core/package.json
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node README.md README.zh-CN.md LICENSE NOTICE ./

USER node

ENTRYPOINT ["node", "./dist/apps/cli/bin.js"]
CMD ["--help"]
