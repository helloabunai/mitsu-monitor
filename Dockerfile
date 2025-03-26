FROM node:14-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY src/ ./src/
COPY tsconfig.json ./
COPY .env.local ./
RUN npx tsc

CMD ["node", "dist/mitsu-main.js"]