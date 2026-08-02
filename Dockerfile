FROM node:22.13.1-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY engine ./engine
COPY server ./server
COPY types ./types

ENV NODE_ENV=production
ENV PORT=2567

EXPOSE 2567

CMD ["./node_modules/.bin/tsx", "--tsconfig", "server/tsconfig.json", "server/index.ts"]
