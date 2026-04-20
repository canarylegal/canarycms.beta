# --- Hot-reload dev (docker compose --profile dev) ---
FROM node:20-alpine AS development

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

# --- Production static assets + nginx ---
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

ARG VITE_API_BASE=
ARG VITE_ONLYOFFICE_URL=/office-ds
ARG VITE_ONLYOFFICE_DIRECT_PORT=
ARG VITE_ONLYOFFICE_DIRECT_URL=

ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_ONLYOFFICE_URL=$VITE_ONLYOFFICE_URL \
    VITE_ONLYOFFICE_DIRECT_PORT=$VITE_ONLYOFFICE_DIRECT_PORT \
    VITE_ONLYOFFICE_DIRECT_URL=$VITE_ONLYOFFICE_DIRECT_URL

RUN npm run build

FROM nginx:1.27-alpine AS production

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
