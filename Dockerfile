FROM node:22-alpine
ARG AEGIS_UID=10001
ARG AEGIS_GID=10001
RUN addgroup -S -g "$AEGIS_GID" aegis \
    && adduser -S -D -H -u "$AEGIS_UID" -G aegis aegis \
    && mkdir -p /app/data \
    && chown aegis:aegis /app/data
WORKDIR /app
COPY --chown=aegis:aegis package.json ./
COPY --chown=aegis:aegis src ./src
COPY --chown=aegis:aegis web ./web
COPY --chown=aegis:aegis scripts ./scripts
USER aegis
EXPOSE 8080 9080
CMD ["node","src/server.js"]
