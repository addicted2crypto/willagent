FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app
RUN addgroup -S agent && adduser -S agent -G agent

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create workspace for sandboxed tool execution
RUN mkdir -p /tmp/agent-workspace && chown agent:agent /tmp/agent-workspace

USER agent
EXPOSE 3100

CMD ["node", "dist/main.js"]
