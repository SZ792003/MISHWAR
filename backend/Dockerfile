FROM node:22-alpine AS deps
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend ./backend
COPY packages ./packages
WORKDIR /app/backend
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend
RUN addgroup -S mishwar && adduser -S mishwar -G mishwar
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/backend/dist-build ./dist-build
COPY backend/package*.json ./
USER mishwar
EXPOSE 4000
CMD ["node", "dist-build/backend/src/server.js"]
