#!/usr/bin/env bash
#
# One script for moving a FIXAM instance to a new server.
#
#   fixam_migrate.sh doctor   --remote minio:fixam-backups
#   fixam_migrate.sh direct   --from user@old-server --snapshot /var/backups/fixam/fixam-...
#   fixam_migrate.sh push     --remote minio:fixam-backups --snapshot /var/backups/fixam/fixam-...
#   fixam_migrate.sh pull     --remote minio:fixam-backups --name fixam-... --dest /tmp/restore
#
# `doctor` tests LIST, GET and PUT separately and reports which one fails.
# S3-behind-a-proxy problems almost always break one verb and not the others,
# and rclone's SDK wraps the real message in enough noise to hide that.
#
# `direct` skips object storage altogether and rsyncs the snapshot from the old
# server over SSH. When the goal is to migrate today and S3 is the thing in the
# way, this is the shortest path that works.

set -uo pipefail

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; DIM=$'\033[2m'; NC=$'\033[0m'

ok()   { printf '%s  ok  %s%s\n' "$GRN" "$NC" "$*"; }
bad()  { printf '%s FAIL %s%s\n' "$RED" "$NC" "$*"; }
warn() { printf '%s warn %s%s\n' "$YEL" "$NC" "$*"; }
info() { printf '%s      %s%s\n' "$DIM" "$NC" "$*"; }
die()  { printf '%sERROR%s %s\n' "$RED" "$NC" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. $2"; }

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

# ─── doctor ──────────────────────────────────────────────────────────────────
#
# Walks the S3 path one verb at a time. The order matters: a failure at
# step 2 means something completely different from a failure at step 5.

cmd_doctor() {
    local remote="${REMOTE:-}"
    [ -n "$remote" ] || die "--remote is required, e.g. minio:fixam-backups"
    need rclone "sudo apt install rclone"

    local name="${remote%%:*}"
    local endpoint
    endpoint=$(rclone config show "$name" 2>/dev/null | awk -F' = ' '/^endpoint/{print $2}')

    echo
    echo "── 1. rclone remote ──"
    if rclone listremotes 2>/dev/null | grep -qx "${name}:"; then
        ok "remote '$name' is configured"
        info "endpoint: ${endpoint:-<none set>}"
    else
        bad "remote '$name' not found"
        info "configured: $(rclone listremotes 2>/dev/null | tr '\n' ' ')"
        info "under sudo? rclone reads root's config, not yours."
        return 1
    fi

    if [ -n "$endpoint" ]; then
        echo
        echo "── 2. endpoint reachability and headers ──"
        local hdrs
        hdrs=$(curl -sS -D - -o /dev/null --max-time 20 "${endpoint%/}/minio/health/live" 2>&1)
        if [ $? -ne 0 ]; then
            bad "cannot reach ${endpoint}"
            info "$hdrs"
        else
            local status server encoding cfray
            status=$(printf '%s' "$hdrs"   | awk 'NR==1{print $2}')
            server=$(printf '%s' "$hdrs"   | grep -i '^server:'           | tr -d '\r')
            encoding=$(printf '%s' "$hdrs" | grep -i '^content-encoding:' | tr -d '\r')
            cfray=$(printf '%s' "$hdrs"    | grep -i '^cf-ray:'           | tr -d '\r')

            [ "$status" = "200" ] && ok "health endpoint returns 200" \
                                  || warn "health endpoint returned $status"
            info "${server:-server: <none>}"

            # The two failure modes that produce unreadable SDK errors.
            if [ -n "$encoding" ]; then
                bad "responses are compressed — $encoding"
                info "The AWS SDK cannot parse a gzipped S3 error body. That is the"
                info "'SerializationError / illegal character code U+001F' you are seeing."
                info "Add  gzip off;  inside the storage server block, then:"
                info "  sudo nginx -t && sudo systemctl reload nginx"
            else
                ok "responses are not compressed"
            fi

            if [ -n "$cfray" ]; then
                bad "Cloudflare is in front of this endpoint ($cfray)"
                info "Cloudflare compresses responses, caps uploads at 100 MB on the"
                info "free plan, and its WAF returns 403 on S3 traffic it dislikes."
                info "Set the storage DNS record to DNS only (grey cloud)."
            else
                ok "no Cloudflare proxy in the path"
            fi
        fi
    fi

    echo
    echo "── 3. LIST (ListObjects) ──"
    local out
    if out=$(rclone lsf "$remote" --max-depth 1 2>&1); then
        ok "list succeeded"
        printf '%s' "$out" | head -5 | sed 's/^/       /'
    else
        bad "list failed"
        printf '%s' "$out" | head -5 | sed 's/^/       /'
        info "LIST failing too means the credential has no policy at all."
        return 1
    fi

    echo
    echo "── 4. PUT (write a probe object) ──"
    local probe="/tmp/.fixam-probe-$$"
    echo "fixam probe $(date -u +%FT%TZ)" > "$probe"
    if out=$(rclone copyto "$probe" "${remote%/}/.fixam-probe" 2>&1); then
        ok "write succeeded"
    else
        bad "write failed"
        printf '%s' "$out" | head -5 | sed 's/^/       /'
    fi

    echo
    echo "── 5. GET (read it back) ──"
    if out=$(rclone cat "${remote%/}/.fixam-probe" 2>&1); then
        ok "read succeeded — S3 path is healthy"
        rclone delete "${remote%/}/.fixam-probe" >/dev/null 2>&1
    else
        bad "read failed while list and write succeeded"
        printf '%s' "$out" | head -8 | sed 's/^/       /'
        echo
        info "That combination means the policy grants s3:ListBucket and"
        info "s3:PutObject but not s3:GetObject. On the MinIO host:"
        info "  mc admin user info fixam backup-agent"
        info "  mc admin policy info fixam backup-only"
        info "and re-attach:"
        info "  mc admin policy attach fixam backup-only --user backup-agent"
        info "  # older mc:  mc admin policy set fixam backup-only user=backup-agent"
    fi
    rm -f "$probe"
    echo
}

# ─── direct ──────────────────────────────────────────────────────────────────
#
# Old server to new server over SSH, no object storage involved. Run this ON
# THE NEW SERVER. rsync resumes, so a dropped connection costs only the
# unfinished file.

cmd_direct() {
    local from="${FROM:-}" snapshot="${SNAPSHOT:-}" dest="${DEST:-/tmp/fixam-restore}"
    [ -n "$from" ]     || die "--from is required, e.g. kvskoker@old.server.ip"
    [ -n "$snapshot" ] || die "--snapshot is required: the path on the OLD server"
    need rsync "sudo apt install rsync"

    mkdir -p "$dest"
    echo "Pulling ${from}:${snapshot}"
    echo "     -> ${dest}"
    echo

    # -z compresses in flight; --partial keeps what arrived if the link drops;
    # --info=progress2 gives one overall percentage rather than per-file spam.
    rsync -az --partial --info=progress2 \
          ${SSH_PORT:+-e "ssh -p $SSH_PORT"} \
          "${from}:${snapshot%/}/" "${dest%/}/$(basename "$snapshot")/" \
        || die "rsync failed"

    local landed="${dest%/}/$(basename "$snapshot")"
    echo
    if [ -f "$landed/manifest.json" ]; then
        ok "snapshot arrived at $landed"
        command -v python3 >/dev/null && python3 - "$landed/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
c = m["database"]["row_counts"]
print(f"       taken {m['created_at']} on {m.get('source_host','?')}")
for t in ("users", "issues", "votes", "feedback"):
    if t in c:
        print(f"       {t:10} {c[t]:>7}")
PY
        echo
        echo "Next:"
        echo "  python3 backend/scripts/fixam_restore.py --snapshot $landed --dry-run"
        echo "  python3 backend/scripts/fixam_restore.py --snapshot $landed"
    else
        bad "no manifest.json in $landed — transfer incomplete"
        exit 1
    fi
}

# ─── push / pull ─────────────────────────────────────────────────────────────

cmd_push() {
    local remote="${REMOTE:-}" snapshot="${SNAPSHOT:-}"
    [ -n "$remote" ] && [ -n "$snapshot" ] || die "--remote and --snapshot are required"
    need rclone "sudo apt install rclone"
    [ -f "${snapshot%/}/manifest.json" ] || die "no manifest.json in $snapshot"
    rclone copy "$snapshot" "${remote%/}/$(basename "$snapshot")" \
        --progress --transfers 4 --checksum || die "upload failed — run: $0 doctor --remote $remote"
    ok "uploaded to ${remote%/}/$(basename "$snapshot")"
}

cmd_pull() {
    local remote="${REMOTE:-}" name="${NAME:-}" dest="${DEST:-/tmp/fixam-restore}"
    [ -n "$remote" ] && [ -n "$name" ] || die "--remote and --name are required"
    need rclone "sudo apt install rclone"
    mkdir -p "$dest"
    rclone copy "${remote%/}/${name}" "${dest%/}/${name}" \
        --progress --transfers 4 --checksum || die "download failed — run: $0 doctor --remote $remote"
    ok "downloaded to ${dest%/}/${name}"
}

# ─── arg parsing ─────────────────────────────────────────────────────────────

[ $# -ge 1 ] || usage
COMMAND="$1"; shift

while [ $# -gt 0 ]; do
    case "$1" in
        --remote)   REMOTE="$2";   shift 2 ;;
        --snapshot) SNAPSHOT="$2"; shift 2 ;;
        --from)     FROM="$2";     shift 2 ;;
        --name)     NAME="$2";     shift 2 ;;
        --dest)     DEST="$2";     shift 2 ;;
        --ssh-port) SSH_PORT="$2"; shift 2 ;;
        -h|--help)  usage ;;
        *)          die "unknown option: $1" ;;
    esac
done

case "$COMMAND" in
    doctor) cmd_doctor ;;
    direct) cmd_direct ;;
    push)   cmd_push ;;
    pull)   cmd_pull ;;
    *)      usage ;;
esac
