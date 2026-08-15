#!/bin/sh
# Give Postgres a TLS certificate before it starts.
#
# Encrypts the connection between the backend and the database. On a single host
# where both containers share a private Docker network this guards against
# another container on that network reading traffic; its real value is that the
# same configuration keeps working when the database moves to its own host,
# where the traffic crosses a wire someone else can reach.
#
# The certificate is self-signed and generated once into the data volume, so it
# survives restarts. A deployment with a real certificate authority should mount
# its own key and certificate over these paths and point DB_SSL_CA at the CA.
set -e

CERT_DIR="/var/lib/postgresql/tls"
mkdir -p "$CERT_DIR"

if [ ! -f "$CERT_DIR/server.key" ]; then
    echo "Generating a self-signed certificate for Postgres TLS..."
    openssl req -new -x509 -days 3650 -nodes -text \
        -out "$CERT_DIR/server.crt" \
        -keyout "$CERT_DIR/server.key" \
        -subj "/CN=postgres" >/dev/null 2>&1
fi

# Postgres refuses to start if the key is readable by anyone else.
chmod 600 "$CERT_DIR/server.key"
chown postgres:postgres "$CERT_DIR/server.key" "$CERT_DIR/server.crt"

exec docker-entrypoint.sh "$@"
