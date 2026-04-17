# --- Build stage ---
FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app
COPY package.json ./
RUN npm install

COPY prisma ./prisma/
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src/
RUN npx tsc

# --- Run stage ---
FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/prisma ./prisma/
COPY package.json ./
# WARP-81: bundle the IEEE OUI vendor registry snapshot. oui-lookup.service
# reads this at startup to resolve MAC prefixes → vendor names.
COPY data/oui.csv ./data/oui.csv

# Run migrations then start server
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
