#!/usr/bin/env bash
#
# Prove the webhook works before pointing Meta at it.
#
#   ./webhook_test.sh verify              the GET handshake Meta performs on save
#   ./webhook_test.sh unsigned            a forged POST must be refused
#   ./webhook_test.sh send 232XXXXXXXX login
#                                         a correctly signed message, end to end
#
# Credentials are read from the running backend container, so there is nothing
# to paste and no secret ends up in your shell history.
#
# `send` drives the real pipeline: the bot processes the message and replies
# over WhatsApp. If you ask it to send "login" from an administrator's number,
# that number receives an actual sign-in code.

set -uo pipefail

BASE="${FIXAM_URL:-https://fixam.sl}"
GRN=$'\033[0;32m'; RED=$'\033[0;31m'; YEL=$'\033[1;33m'; DIM=$'\033[2m'; NC=$'\033[0m'

ok()   { printf '%s  ok  %s%s\n' "$GRN" "$NC" "$*"; }
bad()  { printf '%s FAIL %s%s\n' "$RED" "$NC" "$*"; }
warn() { printf '%s warn %s%s\n' "$YEL" "$NC" "$*"; }
info() { printf '%s      %s%s\n' "$DIM" "$NC" "$*"; }
die()  { printf '%sERROR%s %s\n' "$RED" "$NC" "$*" >&2; exit 1; }

backend_container() {
    docker ps --format '{{.Names}}' | grep -v nominatim | grep backend | head -1
}

env_from_backend() {
    local key="$1" c
    c=$(backend_container)
    [ -n "$c" ] || die "no running backend container found"
    docker exec "$c" printenv "$key" 2>/dev/null | tr -d '\r\n'
}

# ── verify: the GET challenge ────────────────────────────────────────────────
#
# Meta calls this when you save the callback URL. If it does not echo the
# challenge back verbatim, saving fails -- and this is the fastest way to find
# out why without touching the dashboard.

cmd_verify() {
    local token challenge body code
    token=$(env_from_backend WHATSAPP_VERIFY_TOKEN)
    [ -n "$token" ] || die "WHATSAPP_VERIFY_TOKEN is not set in the backend container"

    challenge="fixam-$(date +%s)"
    echo
    info "GET ${BASE}/webhook  (hub.mode=subscribe)"

    body=$(curl -sS -m 20 -w '\n%{http_code}' \
        "${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${challenge}")
    code=$(printf '%s' "$body" | tail -1)
    body=$(printf '%s' "$body" | sed '$d')

    if [ "$code" = "200" ] && [ "$body" = "$challenge" ]; then
        ok "handshake succeeded — Meta will accept this callback URL"
    elif [ "$code" = "403" ]; then
        bad "403: the verify token did not match"
        info "The dashboard token must equal WHATSAPP_VERIFY_TOKEN exactly."
    elif [ "$code" = "200" ]; then
        bad "200 but the challenge was not echoed back"
        info "got: ${body:0:80}"
        info "Something between you and the backend is rewriting the response."
    else
        bad "HTTP $code"
        info "${body:0:200}"
        [ "$code" = "000" ] && info "No response at all — DNS, TLS or the firewall."
    fi
    echo
}

# ── unsigned: a forged delivery must be refused ──────────────────────────────

cmd_unsigned() {
    local code
    echo
    info "POST ${BASE}/webhook  with no signature"
    code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST "${BASE}/webhook" \
        -H 'Content-Type: application/json' \
        -d '{"object":"whatsapp_business_account","entry":[]}')

    if [ "$code" = "403" ]; then
        ok "403 — unsigned deliveries are refused"
    elif [ "$code" = "200" ]; then
        bad "200 — the endpoint accepted an unsigned payload"
        info "WHATSAPP_APP_SECRET is probably unset, so verification is skipped."
        info "Check: docker compose exec backend printenv WHATSAPP_APP_SECRET"
    else
        warn "HTTP $code (expected 403)"
    fi
    echo
}

# ── send: a correctly signed message, through the whole pipeline ─────────────

cmd_send() {
    local phone="${1:-}" text="${2:-login}"
    [ -n "$phone" ] || die "usage: $0 send 232XXXXXXXX [message]"

    local secret phone_id body sig code
    secret=$(env_from_backend WHATSAPP_APP_SECRET)
    phone_id=$(env_from_backend WHATSAPP_PHONE_NUMBER_ID)

    [ -n "$secret" ] || warn "WHATSAPP_APP_SECRET is empty — sending unsigned"
    if [ -z "$phone_id" ]; then
        warn "WHATSAPP_PHONE_NUMBER_ID is empty"
        info "The handler drops deliveries whose phone_number_id does not match it."
    fi

    # The shape Meta actually posts. phone_number_id must match the configured
    # one or processIncomingMessage ignores the delivery without replying.
    body=$(cat <<EOF
{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"${phone_id}","phone_number_id":"${phone_id}"},"messages":[{"from":"${phone}","id":"wamid.test-$(date +%s)","timestamp":"$(date +%s)","type":"text","text":{"body":"${text}"}}]}}]}]}
EOF
)

    echo
    info "POST ${BASE}/webhook  from=${phone}  text=\"${text}\""

    local headers=(-H 'Content-Type: application/json')
    if [ -n "$secret" ]; then
        sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" | awk '{print $NF}')
        headers+=(-H "X-Hub-Signature-256: sha256=${sig}")
    fi

    code=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -X POST "${BASE}/webhook" \
        "${headers[@]}" --data-binary "$body")

    if [ "$code" = "200" ]; then
        ok "accepted (200)"
        info "The bot processes asynchronously, so watch what it did:"
        info "  docker compose logs --tail=30 backend"
        info "  and check WhatsApp on ${phone} for the reply"
    elif [ "$code" = "403" ]; then
        bad "403 — signature rejected"
        info "The container's WHATSAPP_APP_SECRET does not match the app secret"
        info "Meta signs with. Copy it again from Settings > Basic > App Secret."
    else
        bad "HTTP $code"
    fi
    echo
}

case "${1:-}" in
    verify)   cmd_verify ;;
    unsigned) cmd_unsigned ;;
    send)     shift; cmd_send "$@" ;;
    *)        sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
