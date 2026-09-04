FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY apps/web/package.json apps/web/
RUN npm install --workspace=@ticketing/web --include-workspace-root --ignore-scripts
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN npm run build --workspace=@ticketing/web

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
