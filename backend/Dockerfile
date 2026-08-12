FROM node:22

WORKDIR /app/backend

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

EXPOSE 5000
CMD ["node", "server.js"]
