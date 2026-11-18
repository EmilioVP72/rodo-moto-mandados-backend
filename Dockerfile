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

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/uploads

EXPOSE 4000

CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/server.js"]
