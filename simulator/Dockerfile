FROM node:22

WORKDIR /app

COPY backend/package*.json backend/
RUN cd backend && npm install --omit=dev && npm cache clean --force

COPY simulator/package*.json simulator/
RUN cd simulator && npm install --omit=dev && npm cache clean --force

COPY backend/ backend/
COPY simulator/ simulator/

WORKDIR /app/simulator
EXPOSE 4001
CMD ["node", "index.js"]
