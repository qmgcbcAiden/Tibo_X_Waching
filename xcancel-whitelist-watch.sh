#!/bin/sh

# One-shot XCancel whitelist watcher. Cron starts it once every 30 minutes; it
# sends one plain ServerChan notification after a verified success, removes its
# own tagged cron entry and production copy, then exits.

set -u

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

RSS_URL='https://rss.xcancel.com/thsottiaux/rss'
RSS_USER_AGENT='TiboWatch-RSS/1.0'
COMPOSE_FILE='/opt/tibo-watch/docker-compose.yml'
EXPECTED_SCRIPT_PATH='/opt/tibo-watch/xcancel-whitelist-watch.sh'
CRON_MARKER='# tibo-xcancel-whitelist-watch'

probe_file=''
cron_file=''

log() {
  logger -t tibo-xcancel-whitelist-watch -- "$*"
  if [ -t 1 ]; then
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
  fi
}

cleanup() {
  if [ -n "$probe_file" ] && [ -f "$probe_file" ]; then
    rm -f -- "$probe_file"
  fi
  if [ -n "$cron_file" ] && [ -f "$cron_file" ]; then
    rm -f -- "$cron_file"
  fi
}

trap cleanup EXIT
trap 'cleanup; exit 143' HUP INT TERM

rss_is_whitelisted() {
  probe_file=$(mktemp '/tmp/tibo-xcancel-probe.XXXXXX') || return 1
  http_code=$(curl \
    --silent \
    --show-error \
    --location \
    --connect-timeout 10 \
    --max-time 30 \
    --header "User-Agent: $RSS_USER_AGENT" \
    --header 'Accept: application/rss+xml, application/xml;q=0.9' \
    --header 'Cache-Control: no-cache' \
    --output "$probe_file" \
    --write-out '%{http_code}' \
    "$RSS_URL" 2>/dev/null) || http_code='000'

  if [ "$http_code" != '200' ]; then
    log "XCancel probe returned HTTP $http_code; will retry."
    cleanup
    probe_file=''
    return 1
  fi
  if grep -qi 'RSS reader not yet whitelist' "$probe_file"; then
    log 'XCancel whitelist is still pending.'
    cleanup
    probe_file=''
    return 1
  fi
  if ! grep -Eqi '<dc:creator[^>]*>[[:space:]]*@thsottiaux|/thsottiaux/status/[0-9]+' "$probe_file"; then
    log 'XCancel response is not the whitelist placeholder, but it has no verifiable Tibo item; will retry.'
    cleanup
    probe_file=''
    return 1
  fi

  cleanup
  probe_file=''
  return 0
}

maintainer_send_key() {
  docker compose -f "$COMPOSE_FILE" exec -T watcher node --input-type=module -e '
    import { loadConfig } from "./dist/src/config.js";
    import { Store } from "./dist/src/db.js";
    const config = loadConfig();
    const store = new Store(config.databasePath);
    try {
      const target = store.listNotificationTargets().find((item) => item.role === "maintainer");
      if (target) process.stdout.write(target.sendKey);
    } finally {
      store.close();
    }
  ' 2>/dev/null
}

send_notification() {
  send_key=$(maintainer_send_key) || send_key=''
  case "$send_key" in
    SCT*) ;;
    *)
      log 'Could not read the maintainer ServerChan SendKey; will retry.'
      return 1
      ;;
  esac

  probe_file=$(mktemp '/tmp/tibo-serverchan-result.XXXXXX') || return 1
  http_code=$(curl \
    --silent \
    --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --request POST \
    --data-urlencode 'title=XCancel RSS 白名单已开通' \
    --data-urlencode 'desp=XCancel 已为 Tibo Watch 开通 RSS 白名单。直连 RSS 现在可以使用，请启用 XCancel RSS 采集源。' \
    --output "$probe_file" \
    --write-out '%{http_code}' \
    "https://sctapi.ftqq.com/${send_key}.send" 2>/dev/null) || http_code='000'

  if [ "$http_code" = '200' ] && grep -Eq '"code"[[:space:]]*:[[:space:]]*0' "$probe_file"; then
    cleanup
    probe_file=''
    return 0
  fi
  log "ServerChan notification was not confirmed (HTTP $http_code); will retry without deleting the watcher."
  cleanup
  probe_file=''
  return 1
}

remove_cron_registration() {
  cron_file=$(mktemp '/tmp/tibo-xcancel-crontab.XXXXXX') || return 1
  crontab -l 2>/dev/null | grep -Fv "$CRON_MARKER" > "$cron_file" || true
  if ! crontab "$cron_file"; then
    cleanup
    cron_file=''
    return 1
  fi
  cleanup
  cron_file=''
  return 0
}

log 'Running scheduled XCancel whitelist probe.'
if ! rss_is_whitelisted; then
  exit 0
fi

log 'XCancel whitelist verified with a real Tibo RSS item.'
if ! send_notification; then
  exit 1
fi

if ! remove_cron_registration; then
  log 'ServerChan was delivered, but the cron entry could not be removed; keeping the script for manual cleanup.'
  exit 1
fi

log 'ServerChan notification delivered; cron entry removed; deleting the one-shot watcher.'
script_path=$(readlink -f -- "$0" 2>/dev/null || printf '%s' "$0")
if [ "$script_path" = "$EXPECTED_SCRIPT_PATH" ]; then
  rm -f -- "$EXPECTED_SCRIPT_PATH"
else
  log "Refusing self-delete because the running path is unexpected: $script_path"
fi
exit 0
