#!/usr/bin/env python3
"""
Restore a FIXAM snapshot onto this server, upgrading the schema on the way.

The old database is several schema versions behind: no platform_settings, no
first_name/last_name, no district/ward on issues, no bot_flows. So this is a
migration, not a copy, and the order is what makes it safe:

  1. Verify checksums and row counts against the manifest
  2. Snapshot whatever is currently here, so a bad run is reversible
  3. Restore the old dump wholesale into an empty database -- exact old state
  4. Apply init_db.sql then every migration in order -- additive, all guarded
     with IF NOT EXISTS, so they add what is missing and touch nothing else
  5. Label every restored row data_mode='test'
  6. Unpack uploads
  7. Report what arrived

Step 3 restores schema *and* data rather than data-only. A data-only restore
would have to match the new schema column for column, and it does not.

    python3 fixam_restore.py --snapshot /tmp/fixam-restore/fixam-2026...Z
    python3 fixam_restore.py --snapshot ... --dry-run
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

# Order matters. pilot_scope creates platform_settings, which name_quality and
# data_mode both write to. Everything else is independent but cheap.
MIGRATION_ORDER = [
    "init_db.sql",
    "migration_dpg_privacy.sql",
    "migration_location_details.sql",
    "migration_image_provenance.sql",
    "migration_transcription_confidence.sql",
    "migration_routing_roles.sql",
    "migration_pilot_routing.sql",
    "migration_feedback_routing.sql",
    "migration_issue_closure.sql",
    "migration_admin_audit.sql",
    "migration_admin_otp.sql",
    "migration_otp_verified.sql",
    "migration_bot_flows.sql",
    "migration_bot_flow_test_runs.sql",
    "migration_category_examples.sql",
    "migration_report_status.sql",
    "migration_pilot_scope.sql",
    "migration_emergency.sql",
    "migration_name_quality.sql",
    "migration_data_mode.sql",
]

MODE_TABLES = ["issues", "users", "votes", "feedback", "endorsements"]


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def confirm(prompt):
    try:
        return input(f"{prompt} [yes/NO]: ").strip().lower() == "yes"
    except (EOFError, KeyboardInterrupt):
        return False


def find_pg_container():
    if shutil.which("docker") is None:
        return None
    try:
        out = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                             capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return None
    for name in out.split():
        if "nominatim" in name:
            continue
        if "postgres" in name or name.endswith("-db-1"):
            return name
    return None


class Postgres:
    def __init__(self, container, user, database, host, port, password=None):
        self.container, self.user = container, user
        self.database, self.host, self.port = database, host, port
        self.password = password

    def _env(self):
        env = os.environ.copy()
        if self.password:
            env["PGPASSWORD"] = self.password
        env.setdefault("PGCONNECT_TIMEOUT", "15")
        return env

    def _prefix(self, interactive_stdin=False):
        if self.container:
            return ["docker", "exec", "-i" if interactive_stdin else "-i", self.container]
        return []

    def _conn(self, database=None):
        args = ["-U", self.user, "-d", database or self.database]
        if not self.container:
            args += ["-h", self.host, "-p", str(self.port)]
        return args

    def psql(self, sql, database=None, check=True):
        cmd = self._prefix() + ["psql"] + self._conn(database) + ["-v", "ON_ERROR_STOP=1", "-tAc", sql]
        r = subprocess.run(cmd, capture_output=True, text=True, env=self._env())
        if check and r.returncode != 0:
            err = r.stderr.strip()
            if "no password supplied" in err or "fe_sendauth" in err:
                die("Postgres wants a password and none was supplied.\n"
                    "  Pass one with  --db-password 'secret'\n"
                    "  or point at the app's env file with  --env-file /path/to/.env\n"
                    "  or export PGPASSWORD before running.")
            die(f"psql failed:\n{err}")
        return r.stdout.strip()

    def psql_file(self, path: Path, database=None):
        """Feed a .sql file in over stdin, so it works for containers too."""
        cmd = self._prefix() + ["psql"] + self._conn(database) + ["-v", "ON_ERROR_STOP=1"]
        with open(path, "rb") as fh:
            r = subprocess.run(cmd, stdin=fh, capture_output=True, text=True, env=self._env())
        return r.returncode, (r.stderr or "").strip()

    def scalar_maint(self, sql):
        return self.psql(sql, database="postgres")

    def restore_dump(self, dump: Path, database):
        cmd = self._prefix() + ["pg_restore", "--no-owner", "--no-acl",
                                "-U", self.user, "-d", database]
        if not self.container:
            cmd += ["-h", self.host, "-p", str(self.port)]
        with open(dump, "rb") as fh:
            r = subprocess.run(cmd, stdin=fh, capture_output=True, text=True, env=self._env())
        # pg_restore warns about things that do not exist yet; only a hard
        # failure with no tables created is fatal, which the caller checks.
        return r.returncode, (r.stderr or "").strip()


def sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def verify_snapshot(snapshot: Path):
    manifest_path = snapshot / "manifest.json"
    if not manifest_path.exists():
        die(f"no manifest.json in {snapshot}")
    meta = json.loads(manifest_path.read_text())

    log("Verifying checksums...")
    for name, expected in meta.get("checksums", {}).items():
        f = snapshot / name
        if not f.exists():
            die(f"missing file from snapshot: {name}")
        actual = sha256(f)
        if actual != expected:
            die(f"checksum mismatch on {name}\n  expected {expected}\n  actual   {actual}\n"
                f"The transfer corrupted this file. Re-download before restoring.")
        log(f"  {name} OK")
    return meta


def main():
    ap = argparse.ArgumentParser(description="Restore a FIXAM snapshot onto this server.")
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--repo", default="/opt/fixam/app",
                    help="checkout containing backend/db/*.sql")
    ap.add_argument("--uploads", help="where to unpack uploads (auto-detected)")
    ap.add_argument("--container", help="Postgres container name (auto-detected)")
    ap.add_argument("--db-user", default=os.environ.get("DB_USER", "fixam_db_admin"))
    ap.add_argument("--db-name", default=os.environ.get("DB_NAME", "fixam_db"))
    ap.add_argument("--db-host", default=os.environ.get("DB_HOST", "127.0.0.1"))
    ap.add_argument("--db-port", default=os.environ.get("DB_PORT", "5432"))
    ap.add_argument("--db-password", help="database password (else --env-file, else $PGPASSWORD)")
    ap.add_argument("--env-file", help="dotenv file to read DB_PASSWORD from")
    ap.add_argument("--data-mode", default="test", choices=["test", "pilot", "live"],
                    help="label applied to every restored row (default: test)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()

    snapshot = Path(args.snapshot).expanduser().resolve()
    repo = Path(args.repo).expanduser().resolve()
    db_dir = repo / "backend" / "db"
    if not db_dir.is_dir():
        die(f"no backend/db in {repo}. Pass --repo.")

    meta = verify_snapshot(snapshot)
    src_counts = meta["database"]["row_counts"]

    log("")
    log(f"Snapshot from {meta.get('source_host', '?')}, taken {meta['created_at']}")
    for table in ("users", "issues", "votes", "feedback"):
        if table in src_counts:
            log(f"  {table:10} {src_counts[table]:>7}")

    container = args.container or find_pg_container()
    password = args.db_password or os.environ.get("PGPASSWORD")
    if not password and args.env_file:
        for line in Path(args.env_file).read_text(errors="replace").splitlines():
            if line.strip().startswith("DB_PASSWORD="):
                password = line.split("=", 1)[1].strip().strip("\"'")
                break
    if not password and not container:
        env_default = Path(args.repo).expanduser() / ".env"
        if env_default.is_file():
            for line in env_default.read_text(errors="replace").splitlines():
                if line.strip().startswith("DB_PASSWORD="):
                    password = line.split("=", 1)[1].strip().strip("\"'")
                    log(f"Database password read from {env_default}")
                    break

    pg = Postgres(container, args.db_user, args.db_name,
                  args.db_host, args.db_port, password)
    log(f"Target: {'container ' + container if container else 'system Postgres'} "
        f"-> database {args.db_name}")

    existing = pg.psql("SELECT count(*) FROM users", check=False) or "0"
    if existing.isdigit() and int(existing) > 0:
        log(f"WARNING: target database already has {existing} users. "
            f"They will be replaced.")

    if args.dry_run:
        log("")
        log("Dry run: verified the snapshot and reached the database. Nothing changed.")
        log(f"Would apply {len(MIGRATION_ORDER)} schema files after restoring.")
        return

    if not args.yes:
        log("")
        if not confirm(f"Replace the contents of '{args.db_name}' with this snapshot?"):
            log("Aborted.")
            return

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    # 1. Keep what is here now. Cheap, and the only way back if this goes wrong.
    safety = f"{args.db_name}_pre_restore_{stamp}"
    log(f"Snapshotting current database as {safety} ...")
    pg.scalar_maint(f'CREATE DATABASE "{safety}" TEMPLATE "{args.db_name}"')

    # 2. Fresh target.
    log(f"Recreating {args.db_name} ...")
    pg.scalar_maint(
        f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        f"WHERE datname = '{args.db_name}' AND pid <> pg_backend_pid()")
    pg.scalar_maint(f'DROP DATABASE "{args.db_name}"')
    pg.scalar_maint(f'CREATE DATABASE "{args.db_name}" OWNER "{args.db_user}"')

    # 3. Old state, exactly as it was.
    log("Restoring the old database (schema + data)...")
    rc, err = pg.restore_dump(snapshot / "database.dump", args.db_name)
    tables = pg.psql("SELECT count(*) FROM information_schema.tables "
                     "WHERE table_schema = 'public'")
    if not tables.isdigit() or int(tables) == 0:
        die(f"pg_restore produced no tables:\n{err}")
    if rc != 0:
        log(f"  pg_restore reported warnings (normal for cross-version restores):")
        for line in err.splitlines()[:5]:
            log(f"    {line}")
    log(f"  {tables} tables restored")

    # 4. Bring the schema forward.
    log("Applying schema upgrades...")
    applied, skipped = 0, []
    for name in MIGRATION_ORDER:
        path = db_dir / name
        if not path.exists():
            skipped.append(name)
            continue
        rc, err = pg.psql_file(path)
        if rc != 0:
            die(f"{name} failed:\n{err}\n\n"
                f"The database is mid-upgrade. Restore the safety copy:\n"
                f"  DROP DATABASE {args.db_name};\n"
                f"  CREATE DATABASE {args.db_name} TEMPLATE {safety};")
        applied += 1
        log(f"  {name}")
    if skipped:
        log(f"  (not present in this checkout: {', '.join(skipped)})")
    log(f"  {applied} files applied")

    # 5. Everything that came from the old server is historical.
    log(f"Labelling restored rows data_mode='{args.data_mode}' ...")
    for table in MODE_TABLES:
        exists = pg.psql(f"SELECT to_regclass('public.{table}') IS NOT NULL")
        if exists != "t":
            continue
        pg.psql(f"UPDATE {table} SET data_mode = '{args.data_mode}'")
        n = pg.psql(f"SELECT count(*) FROM {table} WHERE data_mode = '{args.data_mode}'")
        log(f"  {table:14} {n:>7}")

    # The mode new data will get from here on. Deliberately not 'test'.
    pg.psql("INSERT INTO platform_settings (key, value) VALUES ('data_mode', 'pilot') "
            "ON CONFLICT (key) DO UPDATE SET value = 'pilot'")
    log("  new records will be labelled 'pilot'")

    # 6. Uploads.
    tar_path = snapshot / "uploads.tar.gz"
    if tar_path.exists():
        dest = Path(args.uploads).expanduser() if args.uploads else None
        if dest is None:
            for vol in ("app_uploads-data", "fixam_uploads-data"):
                try:
                    mount = subprocess.run(
                        ["docker", "volume", "inspect", "-f", "{{ .Mountpoint }}", vol],
                        capture_output=True, text=True, timeout=15).stdout.strip()
                    if mount and Path(mount).is_dir():
                        dest = Path(mount)
                        break
                except Exception:
                    continue
        if dest is None:
            log("WARNING: uploads archive present but no destination found. "
                "Re-run with --uploads /path/to/uploads")
        else:
            log(f"Unpacking uploads into {dest} ...")
            dest.mkdir(parents=True, exist_ok=True)
            with tarfile.open(tar_path) as tar:
                for member in tar.getmembers():
                    if member.name.startswith("/") or ".." in Path(member.name).parts:
                        die(f"refusing unsafe path in archive: {member.name}")
                tar.extractall(dest)
            count = sum(1 for _ in dest.rglob("*") if _.is_file())
            log(f"  {count} files now in place")

    # 7. Did it all arrive?
    log("")
    log("Row counts, old server -> new:")
    ok = True
    for table, expected in sorted(src_counts.items()):
        actual = pg.psql(f"SELECT count(*) FROM {table}", check=False)
        actual_n = int(actual) if actual.isdigit() else -1
        flag = "" if actual_n == expected else "   <-- MISMATCH"
        if actual_n != expected:
            ok = False
        log(f"  {table:20} {expected:>7} -> {actual_n:>7}{flag}")

    log("")
    if ok:
        log("Restore complete. All row counts match.")
    else:
        log("Restore finished with mismatches above. Investigate before going live.")
    log(f"Safety copy retained as '{safety}'. Drop it once you are satisfied:")
    log(f"  DROP DATABASE {safety};")
    log("")
    log("Next:")
    log("  docker compose restart backend")
    log("  docker compose exec backend node scripts/auditNames.js")


if __name__ == "__main__":
    main()
