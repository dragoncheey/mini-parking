FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY utils ./utils

USER node
EXPOSE 8787

CMD ["node", "server/index.js"]
