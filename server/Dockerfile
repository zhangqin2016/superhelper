ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
ENV NODE_ENV=production

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY server/ ./

EXPOSE 3000
CMD ["node", "src/index.js"]
