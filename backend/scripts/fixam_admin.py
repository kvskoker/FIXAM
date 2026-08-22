#!/usr/bin/env python3
"""
Grant, inspect and repair administrator access from the server.

The problem this exists for: two-factor authentication delivers a sign-in code
over WhatsApp, and the bootstrap account (SUPER_ADMIN_PHONE, default
23200000000) is not a real number. Nobody can receive its code. So with 2FA on
and no other administrator, the portal is unreachable and there is no way in
through the portal to fix it.

    python3 fixam_admin.py list
    python3 fixam_admin.py check-2fa
    python3 fixam_admin.py grant --phone 23276123456
    python3 fixam_admin.py reset-password --phone 23276123456

The user must already have registered with the bot on WhatsApp. That is
deliberate: having completed registration proves the number can send and
receive WhatsApp messages, which is the one thing two-factor sign-in
depends on and the one thing a digit-pattern check cannot prove.

Passwords are never taken from the command line -- an argument is visible in
`ps` output and lands in your shell history. The script prompts, hides the
input, and asks twice.

Hashing goes through the backend container's own authService, so the stored
hash is produced by exactly the code that will later verify it. That removes a
whole class of "the password is right but login fails" problems.
"""

import argparse
import getpass
import json
import os
import re
import shutil
import subprocess
import sys

MIN_PASSWORD_LENGTH = 12

# Where the app lives inside the backend image (Dockerfile: WORKDIR /app/backend).
APP = '/app/backend'


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def ok(msg):
    print(f"  \033[0;32mok\033[0m   {msg}")


def warn(msg):
    print(f"  \033[1;33mwarn\033[0m {msg}")


def bad(msg):
    print(f"  \033[0;31mFAIL\033[0m {msg}")


def find_container(name_hint, exclude=("nominatim",)):
    if shutil.which("docker") is None:
        return None
    try:
        out = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                             capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return None
    for name in out.split():
        if any(x in name for x in exclude):
            continue
        if name_hint in name:
            return name
    return None


class Backend:
    """Runs node inside the backend container, reusing the app's own modules."""

    def __init__(self, container):
        self.container = container

    def node(self, script):
        cmd = ["docker", "exec", "-i", self.container, "node", "-e", script]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            die(f"node failed inside {self.container}:\n{(r.stderr or '').strip()}")
        return r.stdout.strip()

    def hash_password(self, password):
        """Hash via authService, so bcrypt cost and variant match the verifier."""
        script = (
            f"const a=require('{APP}/services/authService');"
            "let d='';process.stdin.on('data',c=>d+=c).on('end',async()=>{"
            "process.stdout.write(await a.hashPassword(d));});"
        )
        cmd = ["docker", "exec", "-i", self.container, "node", "-e", script]
        r = subprocess.run(cmd, input=password, capture_output=True, text=True)
        if r.returncode != 0 or not r.stdout.strip().startswith("$2"):
            die(f"could not hash the password:\n{(r.stderr or '').strip()}")
        return r.stdout.strip()

    def readiness(self):
        script = (
            f"const db=require('{APP}/db');"
            f"const r=require('{APP}/services/adminReadiness');"
            "r.check2FAReadiness(db).then(s=>{console.log(JSON.stringify(s));process.exit(0);})"
            ".catch(e=>{console.error(e.message);process.exit(1);});"
        )
        return json.loads(self.node(script))


class Postgres:
    def __init__(self, container, user, database, password=None):
        self.container, self.user = container, user
        self.database, self.password = database, password

    def _env(self):
        env = os.environ.copy()
        if self.password:
            env["PGPASSWORD"] = self.password
        return env

    def run(self, sql, check=True):
        cmd = ["docker", "exec", "-i", self.container, "psql",
               "-U", self.user, "-d", self.database, "-v", "ON_ERROR_STOP=1", "-tAc", sql]
        r = subprocess.run(cmd, capture_output=True, text=True, env=self._env())
        if check and r.returncode != 0:
            die(f"psql failed:\n{(r.stderr or '').strip()}")
        return r.stdout.strip()


def normalise_phone(raw):
    """Digits only. Accepts +232..., 076..., spaces and dashes."""
    digits = re.sub(r"\D", "", str(raw or ""))
    if digits.startswith("00"):
        digits = digits[2:]
    # A local number typed with its leading zero.
    if digits.startswith("0") and len(digits) == 9:
        digits = "232" + digits[1:]
    return digits


def prompt_password():
    while True:
        first = getpass.getpass("New password (hidden): ")
        if len(first) < MIN_PASSWORD_LENGTH:
            print(f"  Too short — at least {MIN_PASSWORD_LENGTH} characters.")
            continue
        second = getpass.getpass("Repeat it: ")
        if first != second:
            print("  They do not match. Try again.")
            continue
        return first


def render_admins(status):
    print()
    print(f"  {'ID':<5} {'PHONE':<15} {'NAME':<24} {'STATUS'}")
    print(f"  {'-'*5} {'-'*15} {'-'*24} {'-'*30}")
    for a in status["admins"]:
        notes = []
        if a["is_disabled"]:
            notes.append("disabled")
        if not a["has_password"]:
            notes.append("no password")
        if not a["usable"] and not notes:
            notes.append("not a reachable number")
        state = "can sign in" if a["usable"] else ", ".join(notes)
        mark = "\033[0;32m*\033[0m" if a["usable"] else " "
        print(f"{mark} {a['id']:<5} {a['phone_number']:<15} {(a['name'] or '')[:24]:<24} {state}")
    print()


# ─── commands ────────────────────────────────────────────────────────────────

def cmd_list(args, pg, be):
    status = be.readiness()
    render_admins(status)
    (ok if status["ready"] else bad)(status["message"])


def cmd_check_2fa(args, pg, be):
    status = be.readiness()
    render_admins(status)
    print("  Two-factor authentication:")
    if status["ready"]:
        ok(status["message"])
        ok("Safe to set ADMIN_2FA_ENABLED=true")
    else:
        bad(status["message"])
        warn("Do NOT enable 2FA yet. Have the person register with the bot on")
        warn("WhatsApp, then grant them admin:")
        warn("  python3 fixam_admin.py grant --phone 232XXXXXXXX")
        sys.exit(2)


def cmd_grant(args, pg, be):
    phone = normalise_phone(args.phone)
    if not phone:
        die("--phone is required")

    # The account must already exist, and that is a feature rather than a
    # limitation. Someone who registered through the bot has demonstrably sent
    # and received WhatsApp messages on that number -- which is the one thing
    # two-factor sign-in depends on and the one thing a digit-pattern check
    # cannot actually prove. Creating accounts here would let an operator
    # invent an administrator who can never receive a code.
    row = pg.run(
        f"SELECT id, COALESCE(name,''), COALESCE(first_name,''), "
        f"(password IS NOT NULL), is_disabled "
        f"FROM users WHERE phone_number = '{phone}'")
    if not row:
        die(f"No user registered with {phone}.\n"
            f"  They must message the bot on WhatsApp and finish registration first —\n"
            f"  that is what proves the number can receive a sign-in code.\n"
            f"  Then run this again.")

    user_id, name, first_name, has_password, disabled = (row.split("|") + [""] * 5)[:5]
    name = name or first_name or "Administrator"

    # Refuse a placeholder outright: granting Admin to a number that cannot
    # receive a code is the exact situation this script exists to get you out
    # of, and doing it silently would be worse than doing nothing.
    plausible = be.node(
        f"const r=require('{APP}/services/adminReadiness');"
        f"process.stdout.write(String(r.isPlausiblePhone('{phone}')));")
    if plausible != "true" and not args.force:
        die(f"{phone} does not look like a real number for this deployment.\n"
            f"  It must start with the country dial code, have the right length,\n"
            f"  and not be a repeated digit like 23200000000.\n"
            f"  Use --force to override if you are certain.")
    if plausible != "true":
        warn(f"{phone} failed the plausibility check — proceeding because --force was given.")
        warn("If it cannot receive WhatsApp, this account will not be able to sign in with 2FA on.")

    # Show who this is before asking for a password. The operator typed a phone
    # number; confirming the name it belongs to is what catches a wrong digit
    # before it becomes an administrator.
    print()
    print(f"  User #{user_id}: {name}")
    print(f"  Phone:  {phone}")
    if disabled == "t":
        print("  Currently disabled — granting admin will re-enable this account.")
    if has_password == "t":
        print("  Already has a password — it will be replaced.")

    if not args.yes:
        answer = input("\n  Make this user a full administrator? [yes/NO]: ").strip().lower()
        if answer != "yes":
            print("  Aborted. Nothing was changed.")
            return

    password = prompt_password()
    hashed = be.hash_password(password)

    # One statement, so a failure cannot leave a half-made administrator: a
    # password set but no role, or a role with no way to authenticate.
    sql = f"""
        WITH admin_role AS (
            SELECT id FROM roles WHERE name = 'Admin'
        ), linked AS (
            INSERT INTO user_roles (user_id, role_id)
            SELECT {user_id}, id FROM admin_role
            ON CONFLICT DO NOTHING
            RETURNING user_id
        )
        UPDATE users
        SET password = '{hashed}',
            role_id = (SELECT id FROM admin_role),
            is_disabled = FALSE
        WHERE id = {user_id}
        RETURNING id;
    """
    updated = pg.run(" ".join(sql.split()))
    if not updated:
        die("the grant did not return a user id — nothing was changed")

    print()
    ok(f"{name} ({phone}) is now a full administrator.")

    status = be.readiness()
    render_admins(status)
    if status["ready"]:
        ok("2FA can now be enabled safely.")
    else:
        warn(status["message"])


def cmd_reset_password(args, pg, be):
    phone = normalise_phone(args.phone)
    existing = pg.run(f"SELECT id FROM users WHERE phone_number = '{phone}'")
    if not existing:
        die(f"no user with phone number {phone}")

    password = prompt_password()
    hashed = be.hash_password(password)
    pg.run(f"UPDATE users SET password = '{hashed}' WHERE id = {existing}")
    ok(f"Password reset for {phone} (user #{existing}).")


def main():
    ap = argparse.ArgumentParser(
        description="Manage FIXAM administrator accounts.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    ap.add_argument("--backend-container", help="backend container (auto-detected)")
    ap.add_argument("--pg-container", help="postgres container (auto-detected)")
    ap.add_argument("--db-user", default=os.environ.get("DB_USER", "fixam_db_admin"))
    ap.add_argument("--db-name", default=os.environ.get("DB_NAME", "fixam_db"))
    ap.add_argument("--db-password", default=os.environ.get("PGPASSWORD"))

    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="show administrators and whether each can sign in")
    sub.add_parser("check-2fa", help="report whether 2FA can be enabled safely")

    p = sub.add_parser("grant",
                       help="make an already-registered user a full administrator")
    p.add_argument("--phone", required=True,
                   help="a number that has already registered with the bot")
    p.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    p.add_argument("--force", action="store_true",
                   help="allow a number that fails the plausibility check")

    p = sub.add_parser("reset-password", help="set a new password for an account")
    p.add_argument("--phone", required=True)

    args = ap.parse_args()

    backend = args.backend_container or find_container("backend")
    postgres = args.pg_container or find_container("postgres")
    if not backend:
        die("no running backend container found. Start the stack, or pass --backend-container.")
    if not postgres:
        die("no running postgres container found. Pass --pg-container.")

    be = Backend(backend)
    pg = Postgres(postgres, args.db_user, args.db_name, args.db_password)

    {
        "list": cmd_list,
        "check-2fa": cmd_check_2fa,
        "grant": cmd_grant,
        "reset-password": cmd_reset_password,
    }[args.command](args, pg, be)


if __name__ == "__main__":
    main()
