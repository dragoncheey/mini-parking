FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=80

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./server
COPY utils ./utils

EXPOSE 80

CMD ["npm", "start"]
