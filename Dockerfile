FROM node:22-alpine AS builder

WORKDIR /app

# OpenSSL is required by Prisma Engine on Alpine Linux
RUN apk add --no-cache openssl

COPY package.json ./
RUN npm install

COPY prisma ./prisma/
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app
RUN apk add --no-cache openssl wget

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/dist ./dist

RUN mkdir -p /app/uploads/restaurants /app/uploads/private && chown -R node:node /app

# Ejecutar proceso de aplicación sin privilegios de root
USER node

EXPOSE 4000

CMD ["sh", "-c", "node prisma/deploy.mjs && exec node dist/server.js"]
