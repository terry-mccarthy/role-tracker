FROM node:22-slim

WORKDIR /app

# Build tools needed to compile better-sqlite3 native bindings
RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# DB lives in a named volume at /app/data so it survives restarts
RUN mkdir -p /app/data

EXPOSE 3000 3100

CMD ["node", "server.js"]
