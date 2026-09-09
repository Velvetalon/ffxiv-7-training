FROM node:22-alpine
WORKDIR /app
COPY site ./site
COPY scripts/serve.mjs ./scripts/serve.mjs
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "scripts/serve.mjs"]
