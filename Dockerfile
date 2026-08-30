# Stock Fastify TACServer runs unmodified on a normal Node container — no
# Workers/nodejs_compat porting risk. Multi-stage: install + build with full
# devDependencies, then ship only prod node_modules + compiled JS.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 8000
CMD ["node", "dist/index.js"]
