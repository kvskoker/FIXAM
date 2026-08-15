# Postgres with TLS.
#
# The stock postgres:17-alpine image ships the TLS libraries but not the
# `openssl` command, so the certificate cannot be generated at start-up without
# it. Adding the tool here keeps the entrypoint simple and means the container
# does not reach for the network on every boot.
FROM postgres:17-alpine

RUN apk add --no-cache openssl

COPY postgres-tls-entrypoint.sh /usr/local/bin/postgres-tls-entrypoint.sh
RUN chmod +x /usr/local/bin/postgres-tls-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/postgres-tls-entrypoint.sh"]
CMD ["postgres"]
