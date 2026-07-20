FROM node:22-alpine
RUN addgroup -S aegis && adduser -S -G aegis aegis
WORKDIR /app
COPY --chown=aegis:aegis package.json ./
COPY --chown=aegis:aegis src ./src
COPY --chown=aegis:aegis web ./web
COPY --chown=aegis:aegis scripts ./scripts
USER aegis
EXPOSE 8080 9080
CMD ["node","src/server.js"]
