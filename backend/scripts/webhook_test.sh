#!/usr/bin/env bash
#
# Prove the webhook works before pointing Meta at it.
#
#   ./webhook_test.sh verify              the GET handshake Meta performs on save
#   ./webhook_test.sh unsigned            a forged POST must be refused
#   ./webhook_test.sh send 232XXXXXXXX login
#                                         a correctly signed message, end to end
#   ./webhook_test.sh token [TOKEN]       can we authenticate to Meta?
#   ./webhook_test.sh watch               live: is Meta reaching this server?
#   ./webhook_test.sh recent              what has arrived lately
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

# ── token: can we authenticate to Meta at all? ───────────────────────────────
#
# Asks the Graph API to describe the configured phone number. It is the
# cheapest call that exercises the token, and it fails the same way a send
# does -- so a green result here means outbound will work.
#
# Pass a token to test one before deploying it:
#   ./webhook_test.sh token EAAG...

cmd_token() {
    local token="${1:-}" phone_id resp
    phone_id=$(env_from_backend WHATSAPP_PHONE_NUMBER_ID)
    [ -n "$token" ] || token=$(env_from_backend WHATSAPP_ACCESS_TOKEN)

    echo
    if [ -z "$token" ]; then
        bad "no access token to test"
        info "WHATSAPP_ACCESS_TOKEN is empty in the backend container."
        echo; return 1
    fi
    info "Token length: ${#token} characters"
    [ "${#token}" -lt 100 ] && warn "Short for a Meta token — likely truncated or temporary."
    info "Phone number ID: ${phone_id:-<unset>}"

    resp=$(curl -sS -m 20 \
        "https://graph.facebook.com/v17.0/${phone_id}?fields=display_phone_number,verified_name,quality_rating" \
        -H "Authorization: Bearer ${token}")

    if printf '%s' "$resp" | grep -q '"display_phone_number"'; then
        ok "token is valid and can read the phone number"
        printf '       %s\n' "$resp"

        # Validity is not lifetime. A 60-day user token passes the check above
        # exactly as a permanent System User token does, and then stops working
        # one quiet afternoon: webhooks still arrive, replies are still composed,
        # and every send fails with 190. Citizens see a bot that went silent.
        # So ask Meta the question that actually matters.
        #
        # input_token has to travel in the query string -- the endpoint accepts
        # it nowhere else -- but the authenticating token goes in the header.
        dbg=$(curl -sS -m 20 \
            "https://graph.facebook.com/v17.0/debug_token?input_token=${token}" \
            -H "Authorization: Bearer ${token}")

        if printf '%s' "$dbg" | grep -q '"expires_at"'; then
            expires_at=$(printf '%s' "$dbg" | grep -o '"expires_at":[0-9]*' | head -1 | cut -d: -f2)
            token_type=$(printf '%s' "$dbg" | grep -o '"type":"[^"]*"' | head -1 | cut -d'"' -f4)

            # Meta reports a non-expiring token as expires_at 0, not a far date.
            if [ "$expires_at" = "0" ]; then
                ok "expiry: never  (type: ${token_type:-unknown})"
            else
                bad "expires $(date -u -d "@${expires_at}" '+%Y-%m-%d %H:%M UTC')  (type: ${token_type:-unknown})"
                info "This token WILL lapse, and the bot will go silent without erroring."
                info "Replace it with a System User token:"
                info "  business.facebook.com > Business Settings > Users > System Users"
                info "  > Add Assets (your app + WABA, Full control) > Generate New Token"
                info "  > Token expiration: Never"
            fi
        else
            warn "could not read token expiry from Meta"
            info "Check by hand -- type must be System User, expiry Never:"
            info "  https://developers.facebook.com/tools/debug/accesstoken"
        fi

        info "Outbound sending will work with this token."
    elif printf '%s' "$resp" | grep -q '"code":190'; then
        bad "190 OAuthException — the token is invalid or expired"
        info "Temporary tokens from the API Setup page last 24 hours."
        info "Generate a System User token that never expires:"
        info "  business.facebook.com > Business Settings > Users > System Users"
        info "  > Add Assets (your WABA, Full control) > Generate New Token"
        info "  > permissions: whatsapp_business_messaging + whatsapp_business_management"
        info "  > Token expiration: Never"
    elif printf '%s' "$resp" | grep -q '"code":100'; then
        bad "100 — the phone number ID is wrong"
        info "Use the 'Phone number ID' from WhatsApp > API Setup, not the number itself."
    else
        bad "unexpected response"
        printf '       %s\n' "$resp"
    fi
    echo
}

# ── watch: is a real message from Meta arriving? ─────────────────────────────
#
# Three layers, because a message can stop at any of them and each has a
# different cause. Watching only the backend log cannot tell you whether Meta
# never called or whether nginx refused it.
#
#   nginx   did an HTTP request reach the server at all
#   backend did the app receive and accept it
#   db      was it recorded
#
# Leave this running, send a message from a real phone, and see how far it gets.

cmd_watch() {
    local c
    c=$(backend_container) || true

    echo
    info "Watching for real deliveries. Send a WhatsApp message to the bot now."
    info "Ctrl-C to stop."
    echo
    printf '%s  nginx  %s= an HTTP request reached the server\n' "$DIM" "$NC"
    printf '%s  app    %s= the backend accepted and processed it\n' "$DIM" "$NC"
    echo

    # Everything that touches /webhook, whatever the outcome.
    ( sudo tail -F /var/log/nginx/access.log 2>/dev/null \
        | grep --line-buffered webhook \
        | sed -u "s/^/${GRN}nginx${NC}  /" ) &
    local nginx_pid=$!

    # The handler's own trace, plus the early returns that silently drop a
    # delivery: a phone-number-id mismatch, the country gate, DEV_MODE, and a
    # rejected signature.
    ( docker logs -f --since 1s "$c" 2>&1 \
        | grep --line-buffered -Ei 'webhook|Message from|Handling|Rejected|Blocked|unsigned|Use configured Phone ID|Mock WhatsApp|Send Error|error|OAuth|token' \
        | sed -u "s/^/${YEL}app${NC}    /" ) &
    local app_pid=$!

    trap 'kill $nginx_pid $app_pid 2>/dev/null; echo; info "stopped"; exit 0' INT TERM
    wait
}

# ── recent: what has actually arrived lately ─────────────────────────────────

cmd_recent() {
    local pg
    pg=$(docker ps --format '{{.Names}}' | grep -v nominatim | grep postgres | head -1)
    [ -n "$pg" ] || die "no running postgres container found"

    echo
    info "Inbound messages recorded in the last hour:"
    docker exec -i "$pg" psql -U "${DB_USER:-fixam_db_admin}" -d "${DB_NAME:-fixam_db}" -c \
        "SELECT id, phone_number, message_type, left(message_body, 40) AS body, created_at
         FROM message_logs
         WHERE direction = 'incoming' AND created_at > NOW() - INTERVAL '1 hour'
         ORDER BY id DESC LIMIT 15;"

    echo
    info "Most recent inbound overall (any age):"
    docker exec -i "$pg" psql -U "${DB_USER:-fixam_db_admin}" -d "${DB_NAME:-fixam_db}" -c \
        "SELECT phone_number, left(message_body, 30) AS body, created_at
         FROM message_logs WHERE direction = 'incoming'
         ORDER BY id DESC LIMIT 3;"
    echo
    info "If the newest row predates the cutover, Meta is still delivering elsewhere."
    echo
}

case "${1:-}" in
    verify)   cmd_verify ;;
    unsigned) cmd_unsigned ;;
    send)     shift; cmd_send "$@" ;;
    token)    shift; cmd_token "${1:-}" ;;
    watch)    cmd_watch ;;
    recent)   cmd_recent ;;
    *)        sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
