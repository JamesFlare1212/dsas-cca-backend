FROM oven/bun:latest

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package.json bun.lock ./

RUN bun install --production

COPY . .

EXPOSE 3000

CMD ["bun", "start"]
