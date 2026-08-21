#!/usr/bin/env python3
"""
Move a FIXAM snapshot between a server and remote storage.

    python3 fixam_transfer.py push --path /var/backups/fixam/fixam-2026...Z --remote gdrive:fixam-backups
    python3 fixam_transfer.py list --remote gdrive:fixam-backups
    python3 fixam_transfer.py pull --name fixam-2026...Z --remote gdrive:fixam-backups --dest /tmp/restore

Transfers go through rclone rather than a cloud SDK, on purpose. A snapshot
with media in it is hundreds of megabytes over a connection that will drop, and
rclone brings resumable chunked uploads, integrity checks and one auth story
for Google Drive, S3, MinIO, Backblaze and everything else. Swapping storage
later is a config change here, not a rewrite.

Optional encryption: --encrypt wraps the snapshot in an age-encrypted tarball
before it leaves the machine. Worth it for anywhere you do not control -- these
files contain citizens' names, phone numbers and photographs.

Install once:
    sudo apt install rclone age
    rclone config          # see the Google Drive notes in docs/DEPLOYMENT.md
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime
from pathlib import Path


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def need(cmd, hint):
    if shutil.which(cmd) is None:
        die(f"{cmd} not installed. {hint}")


# Set once in main(), then prepended to every rclone call.
RCLONE_CONFIG = None


def detect_rclone_config():
    """Find the config the operator actually configured.

    Under sudo, rclone looks in /root and finds nothing, because `rclone config`
    was almost certainly run as the ordinary user. Rather than failing with
    "remote is not configured" while `rclone config` plainly lists it, borrow
    the invoking user's file.
    """
    if os.name != "posix" or os.geteuid() != 0:
        return None
    sudo_user = os.environ.get("SUDO_USER")
    if not sudo_user:
        return None
    if Path("/root/.config/rclone/rclone.conf").is_file():
        return None            # root has its own; respect it
    try:
        import pwd
        home = Path(pwd.getpwnam(sudo_user).pw_dir)
    except (ImportError, KeyError):
        return None
    candidate = home / ".config" / "rclone" / "rclone.conf"
    return candidate if candidate.is_file() else None


def rclone(args, stream=True):
    """Run rclone, letting its progress output through to the terminal."""
    cmd = ["rclone"]
    if RCLONE_CONFIG:
        cmd += ["--config", str(RCLONE_CONFIG)]
    cmd += args
    log(f"$ {' '.join(cmd)}")
    if stream:
        rc = subprocess.call(cmd)
        if rc != 0:
            die(f"rclone exited {rc}")
        return None
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        die(f"rclone failed:\n{result.stderr.strip()}")
    return result.stdout


def check_remote(remote):
    """Fail early and clearly if the remote is not configured."""
    name = remote.split(":", 1)[0]
    out = rclone(["listremotes"], stream=False) or ""
    if f"{name}:" not in out.split():
        hint = "Run: rclone config"
        if os.name == "posix" and os.geteuid() == 0 and os.environ.get("SUDO_USER"):
            user = os.environ["SUDO_USER"]
            hint = (
                "You are running under sudo, so rclone read root's config rather\n"
                f"  than {user}'s. Either drop sudo:\n"
                f"      sudo chown -R {user}: <snapshot-dir>\n"
                "  or point at the right file:\n"
                f"      --rclone-config /home/{user}/.config/rclone/rclone.conf"
            )
        die(f"rclone remote '{name}' is not configured.\n"
            f"Configured remotes: {out.strip() or '(none)'}\n"
            f"{hint}")


def encrypt_dir(src: Path, recipient_file: Path) -> Path:
    """tar the snapshot and encrypt it to the given age recipients."""
    need("age", "sudo apt install age")
    tar_path = src.parent / f"{src.name}.tar"
    enc_path = src.parent / f"{src.name}.tar.age"

    log("Packing for encryption...")
    with tarfile.open(tar_path, "w") as tar:
        tar.add(src, arcname=src.name)

    log("Encrypting...")
    with open(tar_path, "rb") as fin, open(enc_path, "wb") as fout:
        proc = subprocess.run(
            ["age", "--encrypt", "--recipients-file", str(recipient_file)],
            stdin=fin, stdout=fout, stderr=subprocess.PIPE,
        )
    tar_path.unlink(missing_ok=True)
    if proc.returncode != 0:
        enc_path.unlink(missing_ok=True)
        die(f"age failed:\n{proc.stderr.decode(errors='replace').strip()}")

    log(f"  {enc_path.name}  {enc_path.stat().st_size / 1e6:.1f} MB")
    return enc_path


def decrypt_file(enc: Path, identity_file: Path, dest: Path) -> Path:
    need("age", "sudo apt install age")
    tar_path = dest / enc.name.replace(".age", "")

    log("Decrypting...")
    with open(enc, "rb") as fin, open(tar_path, "wb") as fout:
        proc = subprocess.run(
            ["age", "--decrypt", "--identity", str(identity_file)],
            stdin=fin, stdout=fout, stderr=subprocess.PIPE,
        )
    if proc.returncode != 0:
        die(f"age failed:\n{proc.stderr.decode(errors='replace').strip()}")

    log("Unpacking...")
    with tarfile.open(tar_path) as tar:
        # Refuse absolute or parent-traversing paths: this archive came back
        # from storage we may not fully control.
        for member in tar.getmembers():
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                die(f"refusing unsafe path in archive: {member.name}")
        tar.extractall(dest)
    tar_path.unlink(missing_ok=True)

    extracted = dest / enc.name.replace(".tar.age", "")
    return extracted


def cmd_push(args):
    src = Path(args.path).expanduser().resolve()
    if not src.is_dir():
        die(f"not a directory: {src}")
    if not (src / "manifest.json").exists():
        die(f"no manifest.json in {src} — is this a fixam_backup.py snapshot?")

    check_remote(args.remote)

    if args.encrypt:
        recipients = Path(args.encrypt).expanduser()
        if not recipients.is_file():
            die(f"age recipients file not found: {recipients}")
        payload = encrypt_dir(src, recipients)
        target = f"{args.remote.rstrip('/')}/{payload.name}"
        rclone(["copyto", str(payload), target, "--progress"])
        payload.unlink(missing_ok=True)
    else:
        target = f"{args.remote.rstrip('/')}/{src.name}"
        rclone(["copy", str(src), target, "--progress",
                "--transfers", "4", "--checksum"])

    log("")
    log(f"Uploaded to {target}")
    log("Verify it landed:")
    log(f"  python3 fixam_transfer.py list --remote {args.remote}")


def cmd_list(args):
    check_remote(args.remote)
    out = rclone(["lsf", args.remote, "--dirs-only"], stream=False) or ""
    entries = [e for e in out.splitlines() if e.strip()]

    files = rclone(["lsf", args.remote, "--files-only"], stream=False) or ""
    encrypted = [f for f in files.splitlines() if f.endswith(".tar.age")]

    if not entries and not encrypted:
        log("No snapshots found.")
        return
    log("Snapshots:")
    for e in sorted(entries):
        print(f"  {e.rstrip('/')}")
    for e in sorted(encrypted):
        print(f"  {e}   (encrypted)")


def cmd_pull(args):
    check_remote(args.remote)
    dest = Path(args.dest).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)

    if args.name.endswith(".tar.age"):
        if not args.identity:
            die("--identity is required to decrypt an .age snapshot")
        local = dest / args.name
        rclone(["copyto", f"{args.remote.rstrip('/')}/{args.name}",
                str(local), "--progress"])
        snapshot = decrypt_file(local, Path(args.identity).expanduser(), dest)
        local.unlink(missing_ok=True)
    else:
        snapshot = dest / args.name
        rclone(["copy", f"{args.remote.rstrip('/')}/{args.name}",
                str(snapshot), "--progress", "--transfers", "4", "--checksum"])

    manifest = snapshot / "manifest.json"
    if not manifest.exists():
        die(f"downloaded, but no manifest.json in {snapshot}")

    meta = json.loads(manifest.read_text())
    log("")
    log(f"Downloaded to {snapshot}")
    log(f"  taken {meta['created_at']} on {meta.get('source_host', '?')}")
    log(f"  {meta['database']['row_counts'].get('issues', '?')} issues, "
        f"{meta['database']['row_counts'].get('users', '?')} users")
    log("")
    log("Next:")
    log(f"  python3 fixam_restore.py --snapshot {snapshot}")


def main():
    ap = argparse.ArgumentParser(description="Move FIXAM snapshots to and from remote storage.")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("push", help="upload a snapshot")
    p.add_argument("--path", required=True)
    p.add_argument("--remote", required=True, help="rclone target, e.g. gdrive:fixam-backups")
    p.add_argument("--encrypt", metavar="RECIPIENTS_FILE",
                   help="age recipients file; encrypts before upload")
    p.add_argument("--rclone-config", help="path to rclone.conf (auto-detected under sudo)")
    p.set_defaults(func=cmd_push)

    p = sub.add_parser("list", help="list snapshots in storage")
    p.add_argument("--remote", required=True)
    p.add_argument("--rclone-config", help="path to rclone.conf (auto-detected under sudo)")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("pull", help="download a snapshot")
    p.add_argument("--name", required=True, help="snapshot directory or .tar.age file")
    p.add_argument("--remote", required=True)
    p.add_argument("--dest", default="/tmp/fixam-restore")
    p.add_argument("--identity", metavar="AGE_KEY_FILE",
                   help="age identity file, for encrypted snapshots")
    p.add_argument("--rclone-config", help="path to rclone.conf (auto-detected under sudo)")
    p.set_defaults(func=cmd_pull)

    args = ap.parse_args()
    need("rclone", "sudo apt install rclone")

    global RCLONE_CONFIG
    RCLONE_CONFIG = getattr(args, "rclone_config", None) or detect_rclone_config()
    if RCLONE_CONFIG:
        log(f"Using rclone config {RCLONE_CONFIG}")

    args.func(args)


if __name__ == "__main__":
    main()
