FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY server/ ./

EXPOSE 3000
CMD ["node", "src/index.js"]
