# Encryption

What the platform does itself, and what the deployment has to do. The split
matters: two of the three controls below cannot be implemented in application
code, and a document that blurred that would leave a gap nobody owned.

---

## 1. In transit — done in the platform

### Backend, simulator and AI engine to the database

Every database connection is encrypted. Postgres starts with `ssl=on` using a
certificate generated on first boot, and all three services connect with TLS.

Verify on a running deployment:

```bash
docker compose exec postgres psql -U fixam_db_admin -d fixam_db -c "SELECT a.client_addr, s.ssl, s.version, s.cipher FROM pg_stat_ssl s JOIN pg_stat_activity a ON a.pid = s.pid WHERE a.datname = 'fixam_db' AND a.client_addr IS NOT NULL;"
```

Every row should read `t` with a TLS version. A row showing `f` is a service
connecting in the clear and should be investigated before go-live.

Controlled by `DB_SSL` (default `true`). It is a single switch across all
services deliberately: when it was possible for one service to opt out, one
quietly did.

The bundled certificate is self-signed, so the connection is encrypted but the
server's identity is not verified. For a deployment where the database is on a
separate host, supply a real certificate and set `DB_SSL_CA` to the CA file —
the backend then verifies the server rather than trusting whatever answers.

```yaml
# docker-compose.override.yml
services:
  postgres:
    volumes:
      - ./certs/server.crt:/var/lib/postgresql/tls/server.crt:ro
      - ./certs/server.key:/var/lib/postgresql/tls/server.key:ro
  backend:
    environment:
      DB_SSL_CA: /run/secrets/db-ca.crt
    volumes:
      - ./certs/ca.crt:/run/secrets/db-ca.crt:ro
```

### Citizens and administrators to the platform

Terminate HTTPS in front of nginx. The platform does not manage certificates
for its own public address; put it behind a reverse proxy or load balancer with
a certificate for the real hostname, and redirect port 80 to 443 there.

Until that is done, administrator passwords and one-time codes cross the network
in the clear. **This is the single most important item on this page** and it is
not something the application can do for you.

---

## 2. At rest — a deployment control

Encryption at rest protects data on a disk that leaves your control: a stolen
server, a copied backup, a decommissioned drive, a cloud volume snapshot. The
control that addresses that is **full-volume encryption underneath Docker**, not
anything the application does to individual files.

The platform keeps persistent data in three Docker volumes:

| Volume | Contents |
|---|---|
| `pgdata` | The database: reports, accounts, phone numbers, the audit trail |
| `uploads-data` | Photographs, videos and voice notes sent by citizens |
| `model-cache` | AI model weights — no personal data, encryption optional |
| `nominatim-data` | Public OpenStreetMap map data — no personal data, encryption optional |

### Cloud deployments

Every major provider encrypts block storage transparently. Create the instance
with an encrypted root or data volume and place Docker's data directory on it.
Nothing in the compose file changes.

- AWS: EBS encryption by default, plus KMS key selection.
- Azure: encryption at host, or Azure Disk Encryption.
- GCP: encrypted at rest by default; supply a CMEK if you want to hold the key.

### A server you own — LUKS

```bash
# One time, on an empty block device
sudo cryptsetup luksFormat /dev/sdb
sudo cryptsetup open /dev/sdb fixam-data
sudo mkfs.ext4 /dev/mapper/fixam-data
sudo mkdir -p /srv/fixam-data
sudo mount /dev/mapper/fixam-data /srv/fixam-data
```

Point Docker's volumes at the encrypted mount:

```yaml
# docker-compose.override.yml
volumes:
  pgdata:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /srv/fixam-data/pgdata
  uploads-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /srv/fixam-data/uploads
```

Confirm the mapping is live before trusting it:

```bash
lsblk -o NAME,TYPE,MOUNTPOINT,FSTYPE | grep -A1 crypt
docker volume inspect codebase_pgdata --format '{{.Options.device}}'
```

An encrypted volume that is unlocked at boot from a key file on the same
unencrypted disk protects nothing. The passphrase must come from somewhere the
thief does not also have: manual entry at boot, a TPM, or a network key server.

### Backups

Backups leave the encrypted volume and are the most commonly overlooked copy.
Encrypt the dump itself, not just the disk it started on:

```bash
docker compose exec -T postgres pg_dump -U fixam_db_admin fixam_db \
  | gpg --symmetric --cipher-algo AES256 -o "fixam-$(date +%F).sql.gpg"
```

---

## 3. What is deliberately *not* encrypted at column level

Phone numbers, names and report text are stored in ordinary columns.

Encrypting the phone number column was considered and set aside for the pilot.
The bot looks up a user by phone number on **every inbound message**, so an
encrypted column needs a searchable index alongside it — a keyed hash — and that
index is itself enough to confirm whether a given number is in the database.
The protection is real but narrower than it first appears, and it touches every
user lookup in the bot.

It is worth doing when the key can be held somewhere the application server is
not — a KMS or an HSM. Encrypting a column with a key sitting in the same
environment as the data mainly protects against someone who reads the database
file but not the application configuration, which is a narrow threat compared
with the stolen-disk case that volume encryption already covers.

The same reasoning applies to encrypting uploaded media files on disk.

---

## Summary

| Control | Status | Owned by |
|---|---|---|
| Database connections encrypted | **In place**, TLS 1.3 | Platform |
| Passwords hashed (bcrypt) | **In place** | Platform |
| Sign-in codes hashed | **In place** | Platform |
| Session tokens signed | **In place** | Platform |
| HTTPS for the public site | **Required before go-live** | Deployment |
| Volume encryption for database and uploads | **Required before go-live** | Deployment |
| Encrypted backups | **Required before go-live** | Deployment |
| Column-level encryption of phone numbers | Deferred, with reasons above | Future |
