#!/usr/bin/env python3
"""
Take a complete, verifiable snapshot of a FIXAM instance.

Produces one directory containing the database, the citizen uploads, and a
manifest recording what was captured and the SHA-256 of every file. The
manifest is what makes the restore trustworthy: without it you find out a
transfer truncated something when you try to read the data, which is usually
weeks later.

Works against either deployment shape. If Postgres is in a container it runs
pg_dump inside it; if it is a system service it runs pg_dump directly. Nothing
here needs pip -- stdlib only, shelling out to pg_dump and tar.

    python3 fixam_backup.py --out /var/backups/fixam
    python3 fixam_backup.py --out /var/backups/fixam --uploads /srv/fixam/uploads

The result is safe to hand to fixam_transfer.py.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# Tables whose row counts go into the manifest. The restore compares against
# these, so a partial dump is caught on arrival rather than in production.
COUNTED_TABLES = [
    "users", "issues", "votes", "feedback", "endorsements",
    "categories", "groups", "user_roles", "issue_tracker",
    "user_point_logs", "message_logs", "conversation_state",
]

# Where uploads live, in order of likelihood. The Docker deployment mounts a
# named volume; the bare-metal one writes under the frontend directory.
UPLOAD_CANDIDATES = [
    "/opt/fixam/app/frontend/uploads",
    "/var/www/fixam/frontend/uploads",
    "./frontend/uploads",
]


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd, **kw):
    """Run a command, raising with the command line included on failure."""
    try:
        return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)
    except FileNotFoundError:
        die(f"command not found: {cmd[0]}")
    except subprocess.CalledProcessError as e:
        err = (e.stderr or "").strip()
        if "no password supplied" in err or "fe_sendauth" in err:
            die("Postgres wants a password and none was supplied.\n"
                "  Pass one with  --db-password 'secret'\n"
                "  or point at the app's env file with  --env-file /path/to/.env\n"
                "  or export PGPASSWORD before running.")
        die(f"{' '.join(cmd[:3])}... failed ({e.returncode}):\n{err}")


def password_from_env_file(path):
    """Pull DB_PASSWORD out of a dotenv file without importing anything."""
    try:
        for line in Path(path).read_text(errors="replace").splitlines():
            line = line.strip()
            if line.startswith("DB_PASSWORD="):
                value = line.split("=", 1)[1].strip()
                # Tolerate quoted values even though Compose dislikes them.
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                return value
    except OSError as e:
        die(f"cannot read {path}: {e}")
    return None


def find_env_file():
    """The old server's app directory, wherever it happens to be."""
    for candidate in (
        "./backend/.env", "./.env",
        "/opt/fixam/app/.env", "/opt/fixam/app/backend/.env",
        Path.home() / "FIXAM" / "backend" / ".env",
        Path.home() / "FIXAM" / ".env",
    ):
        p = Path(candidate)
        if p.is_file():
            return p
    return None


def have(cmd):
    return shutil.which(cmd) is not None


def find_pg_container():
    """Return the name of a running Postgres container, or None."""
    if not have("docker"):
        return None
    try:
        out = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=15,
        ).stdout
    except Exception:
        return None
    for name in out.split():
        # Skip Nominatim: it runs its own Postgres and is not the app database.
        if "nominatim" in name:
            continue
        if "postgres" in name or name.endswith("-db-1"):
            return name
    return None


class Postgres:
    """pg_dump / psql, whether Postgres is containerised or not."""

    def __init__(self, container, user, database, host, port, password=None):
        self.container = container
        self.user = user
        self.database = database
        self.host = host
        self.port = port
        self.password = password

    def _prefix(self):
        if self.container:
            return ["docker", "exec", "-i", self.container]
        return []

    def _conn_args(self):
        args = ["-U", self.user, "-d", self.database]
        if not self.container:
            args += ["-h", self.host, "-p", str(self.port)]
        return args

    def _env(self):
        """PGPASSWORD carried to every child, so nothing ever prompts."""
        env = os.environ.copy()
        if self.password:
            env["PGPASSWORD"] = self.password
        # A prompt in a script is a hang, not a question. Fail instead.
        env.setdefault("PGCONNECT_TIMEOUT", "15")
        return env

    def query_scalar(self, sql):
        cmd = self._prefix() + ["psql"] + self._conn_args() + ["-tAc", sql]
        return run(cmd, env=self._env()).stdout.strip()

    def dump_to(self, path):
        """Custom format: compressed, and restorable table by table."""
        cmd = self._prefix() + ["pg_dump"] + self._conn_args() + ["-Fc", "--no-owner", "--no-acl"]
        with open(path, "wb") as fh:
            proc = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.PIPE, env=self._env())
            _, err = proc.communicate()
        if proc.returncode != 0:
            die(f"pg_dump failed:\n{err.decode(errors='replace').strip()}")

    def row_counts(self):
        """Every count in two queries rather than two per table.

        The old version issued a couple of dozen separate psql calls, which is
        slow over TCP and -- before PGPASSWORD was passed through -- prompted
        for the password on every single one.
        """
        listed = self.query_scalar(
            "SELECT string_agg(table_name, ',') FROM information_schema.tables "
            "WHERE table_schema = 'public'")
        present = [t for t in COUNTED_TABLES if t in (listed or "").split(",")]
        if not present:
            return {}

        union = " UNION ALL ".join(
            f"SELECT '{t}' AS t, count(*) AS n FROM {t}" for t in present)
        out = self.query_scalar(
            f"SELECT string_agg(t || '=' || n, ',') FROM ({union}) x")

        counts = {}
        for pair in (out or "").split(","):
            if "=" in pair:
                name, _, n = pair.partition("=")
                counts[name] = int(n)
        return counts


def sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def resolve_uploads(explicit):
    if explicit:
        p = Path(explicit).expanduser().resolve()
        if not p.is_dir():
            die(f"uploads directory not found: {p}")
        return p

    # Docker named volume, if one is mounted.
    if have("docker"):
        try:
            out = subprocess.run(
                ["docker", "volume", "ls", "--format", "{{.Name}}"],
                capture_output=True, text=True, timeout=15,
            ).stdout
            for vol in out.split():
                if "uploads" not in vol:
                    continue
                mount = subprocess.run(
                    ["docker", "volume", "inspect", "-f", "{{ .Mountpoint }}", vol],
                    capture_output=True, text=True, timeout=15,
                ).stdout.strip()
                if mount and Path(mount).is_dir():
                    return Path(mount)
        except Exception:
            pass

    for candidate in UPLOAD_CANDIDATES:
        p = Path(candidate).expanduser()
        if p.is_dir():
            return p.resolve()

    return None


def archive_uploads(src, dest):
    """tar.gz the uploads tree. Returns (file_count, total_bytes)."""
    files = 0
    total = 0
    with tarfile.open(dest, "w:gz") as tar:
        for root, _dirs, names in os.walk(src):
            for name in names:
                full = Path(root) / name
                if not full.is_file():
                    continue
                try:
                    total += full.stat().st_size
                except OSError:
                    continue
                tar.add(full, arcname=str(full.relative_to(src)))
                files += 1
                if files % 500 == 0:
                    log(f"  ... {files} files")
    return files, total


def main():
    ap = argparse.ArgumentParser(description="Back up a FIXAM instance.")
    ap.add_argument("--out", required=True, help="directory to write the snapshot into")
    ap.add_argument("--uploads", help="uploads directory (auto-detected if omitted)")
    ap.add_argument("--container", help="Postgres container name (auto-detected)")
    ap.add_argument("--db-user", default=os.environ.get("DB_USER", "fixam_db_admin"))
    ap.add_argument("--db-name", default=os.environ.get("DB_NAME", "fixam_db"))
    ap.add_argument("--db-host", default=os.environ.get("DB_HOST", "127.0.0.1"))
    ap.add_argument("--db-port", default=os.environ.get("DB_PORT", "5432"))
    ap.add_argument("--db-password", help="database password (else --env-file, else $PGPASSWORD)")
    ap.add_argument("--env-file", help="dotenv file to read DB_PASSWORD from (auto-detected)")
    ap.add_argument("--label", default="", help="suffix for the snapshot name, e.g. pre-migration")
    ap.add_argument("--skip-uploads", action="store_true")
    args = ap.parse_args()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = f"fixam-{stamp}" + (f"-{args.label}" if args.label else "")
    outdir = Path(args.out).expanduser().resolve() / name
    outdir.mkdir(parents=True, exist_ok=False)

    container = args.container or find_pg_container()
    log(f"Postgres: {'container ' + container if container else 'system service'}")

    password = args.db_password or os.environ.get("PGPASSWORD")
    if not password and not container:
        env_file = args.env_file or find_env_file()
        if env_file:
            password = password_from_env_file(env_file)
            if password:
                log(f"Database password read from {env_file}")
    if not password and not container:
        log("No password found. If Postgres uses peer or trust auth this is fine;")
        log("otherwise pass --db-password or --env-file.")

    pg = Postgres(container, args.db_user, args.db_name,
                  args.db_host, args.db_port, password)

    version = pg.query_scalar("SHOW server_version")
    log(f"Server version {version}, database {args.db_name}")

    log("Counting rows...")
    counts = pg.row_counts()
    for table, n in sorted(counts.items()):
        log(f"  {table:20} {n:>8}")

    log("Dumping database...")
    dump_path = outdir / "database.dump"
    pg.dump_to(dump_path)
    log(f"  {dump_path.stat().st_size / 1e6:.1f} MB")

    uploads_info = {"included": False}
    if not args.skip_uploads:
        src = resolve_uploads(args.uploads)
        if src is None:
            log("WARNING: no uploads directory found. Pass --uploads to include one.")
        else:
            log(f"Archiving uploads from {src} ...")
            tar_path = outdir / "uploads.tar.gz"
            files, total = archive_uploads(src, tar_path)
            uploads_info = {
                "included": True,
                "source": str(src),
                "file_count": files,
                "source_bytes": total,
                "archive_bytes": tar_path.stat().st_size,
            }
            log(f"  {files} files, {total / 1e6:.1f} MB -> "
                f"{tar_path.stat().st_size / 1e6:.1f} MB compressed")

    log("Checksumming...")
    checksums = {
        p.name: sha256(p)
        for p in sorted(outdir.iterdir())
        if p.is_file() and p.name != "manifest.json"
    }

    manifest = {
        "format_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_host": os.uname().nodename,
        "database": {
            "name": args.db_name,
            "server_version": version,
            "row_counts": counts,
        },
        "uploads": uploads_info,
        "checksums": checksums,
    }
    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    total_bytes = sum(p.stat().st_size for p in outdir.iterdir() if p.is_file())
    log("")
    log(f"Snapshot ready: {outdir}")
    log(f"  {total_bytes / 1e6:.1f} MB total")
    log("")
    log("Next:")
    log(f"  python3 fixam_transfer.py push --path {outdir} --remote <rclone-remote>:fixam-backups")


if __name__ == "__main__":
    main()
