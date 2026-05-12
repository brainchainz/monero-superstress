FROM node:20-alpine

# zeromq build deps (for native addon fallback)
RUN apk add --no-cache python3 make g++ zeromq-dev

WORKDIR /app

COPY package*.json ./
# Don't use --ignore-scripts — zeromq needs its postinstall for prebuilt binaries
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

RUN mkdir -p /app/data

EXPOSE 3001

CMD ["node", "dist/index.js"]
