#!/usr/bin/env bash
# scripts/demo-video.sh
#
# Re-runnable demo video generator for fck-chat-control.
#
# Opens two isolated browser sessions (Alice + Bob) against an ALREADY-RUNNING
# dev/preview server, walks through the full private-chat flow (start -> join ->
# connect -> exchange messages -> verify safety number) while recording Alice's
# window, then burns in timed captions with ffmpeg and writes a compressed WebM.
#
# It does NOT start or stop the dev server. Boot it yourself first:
#   pnpm dev                                   # serves http://localhost:3001
# then in another terminal:
#   bash scripts/demo-video.sh                 # writes docs/media/chat-demo.webm
#
# Re-run any time the UI changes -- the output is overwritten in place.
#
# Usage:
#   bash scripts/demo-video.sh
#   BASE_URL=http://localhost:3001/ OUT=docs/media/chat-demo.webm bash scripts/demo-video.sh
#
# Env vars (all optional):
#   BASE_URL   server URL to record against   (default http://localhost:3001/)
#   OUT        output webm path               (default docs/media/chat-demo.webm)
#   RAW        intermediate raw webm path     (default /tmp/chat-demo-raw.webm)
#   KEEP_RAW   "1" to keep the raw recording  (default unset)
#   FONT       ttf path for drawtext          (default auto-detected)
#
# Prerequisites (install once):
#   npm i -g agent-browser && agent-browser install      # Chrome for CDP
#   ffmpeg                                                 # captions + compress
#   pnpm install                                           # repo deps
#
# Notes:
#   * The server MUST already be up and reachable at $BASE_URL before you run
#     this script. It will fail fast if not -- start it with `pnpm dev`.
#   * `vp dev` binds IPv6 ::1 only, so use http://localhost:PORT/, not 127.0.0.1.
#   * agent-browser's `--session <name>` is a GLOBAL flag and must precede the
#     subcommand:  `agent-browser --session alice open <url>`.
#   * Do NOT use agent-browser's --allowed-domains here -- it disables
#     RTCPeerConnection, which would break the WebRTC chat handshake.
#
# Exit codes: 0 success; non-zero on any failure. Only the browser sessions are
# closed on exit -- your dev server is left running.

set -uo pipefail

# ---------- paths and params -------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://localhost:3001/}"
OUT="${OUT:-$REPO_ROOT/docs/media/chat-demo.webm}"
RAW="${RAW:-/tmp/chat-demo-raw.webm}"
KEEP_RAW="${KEEP_RAW:-0}"

export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

# Auto-pick a bold TTF for ffmpeg drawtext if not provided.
if [[ -z "${FONT:-}" ]]; then
  FONT="$(find /usr/share/fonts -name "LiberationSans-Bold.ttf" 2>/dev/null | head -1)"
  [[ -z "$FONT" ]] && FONT="$(find /usr/share/fonts -name "DejaVuSans-Bold.ttf" 2>/dev/null | head -1)"
fi
if [[ -z "$FONT" || ! -f "$FONT" ]]; then
  echo "FATAL: no bold TTF font found for ffmpeg drawtext" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUT")"
rm -f "$RAW" "$OUT"

# ---------- helpers ----------------------------------------------------------
# Note: do NOT wrap "npx agent-browser" in a shell variable -- word-splitting
# breaks flag parsing. Call it directly each time.

log() { printf '\n\033[1;36m[demo]\033[0m %s\n' "$*"; }

# Close only the browser sessions this script opened. The dev server is the
# caller's responsibility and is NEVER touched here.
teardown() {
  log "closing browser sessions"
  npx agent-browser --session alice record stop >/dev/null 2>&1 || true
  npx agent-browser close --all >/dev/null 2>&1 || true
}
trap teardown EXIT

# Extract the first ref matching a regex from a session's interactive snapshot.
# Usage:  ref_for <session> <grep-regex>   -> prints "eN" (without @), empty if none.
ref_for() {
  local session="$1" pattern="$2"
  npx agent-browser --session "$session" snapshot -i 2>/dev/null \
    | grep -iE "$pattern" \
    | grep -oE 'ref=e[0-9]+' \
    | head -1 \
    | sed 's/ref=//'
}

# Wait until a session's snapshot contains $2 (case-insensitive), timeout $3s.
wait_for_text() {
  local session="$1" needle="$2" timeout="${3:-10}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if npx agent-browser --session "$session" snapshot -i 2>/dev/null | grep -qi "$needle"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Wait for $1 sessions to show "Connected", timeout $2s.
wait_for_connected() {
  local need="$1" timeout="${2:-25}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    local alice_state bob_state n=0
    alice_state="$(npx agent-browser --session alice read 2>/dev/null || true)"
    bob_state="$(npx agent-browser --session bob read 2>/dev/null || true)"
    grep -qi "Connected" <<<"$alice_state" && n=$((n + 1))
    grep -qi "Connected" <<<"$bob_state"   && n=$((n + 1))
    if (( n >= need )); then echo "connected"; return 0; fi
    sleep 1
  done
  return 1
}

# ---------- 0. confirm the server is already up ------------------------------
log "checking that the server is already up at $BASE_URL"
if ! curl -sf -o /dev/null "$BASE_URL"; then
  echo "FATAL: $BASE_URL is not responding. Start the dev server first:" >&2
  echo "  pnpm dev   (then run this script again)" >&2
  exit 3
fi
log "server reachable at $BASE_URL"

# ---------- 1. configure viewport + open Alice, start recording -------------
npx agent-browser close --all >/dev/null 2>&1 || true

log "opening Alice at $BASE_URL"
npx agent-browser --session alice open "$BASE_URL" >/dev/null
npx agent-browser --session alice set viewport 1920 1080 >/dev/null

log "starting recorder on Alice's session"
npx agent-browser --session alice record start "$RAW" >/dev/null
RECORDING_STARTED=1

# Wait for the landing button to render.
wait_for_text alice "Start a conversation" 15 || log "WARN: landing button not found in 15s"

# ============================================================================
# BEAT 1 -- LANDING              caption: 1.0s - 6.0s
#   "No account. No phone number. Open a link, talk."
# ============================================================================
sleep 5   # let the landing settle on camera

# ============================================================================
# BEAT 2 -- ALICE STARTS         caption: 6.0s - 12.0s
#   "Alice starts the chat -- the link is just a random ID."
# ============================================================================
log "Alice: click 'Start a conversation'"
START_REF="$(ref_for alice 'Start a conversation')"
if [[ -z "$START_REF" ]]; then
  echo "FATAL: could not find 'Start a conversation' ref" >&2
  exit 4
fi
npx agent-browser --session alice click "@${START_REF}" >/dev/null

# The invitation input should appear on the same panel.
wait_for_text alice "Invitation link" 10 || log "WARN: invitation input not found"
sleep 3

# Read the invitation URL Alice generated.
INVITATION="$(npx agent-browser --session alice get value 'input[aria-label="Invitation link"]' 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
if [[ -z "$INVITATION" ]]; then
  echo "FATAL: invitation link is empty" >&2
  exit 5
fi
log "Alice: invitation = $INVITATION"

# ============================================================================
# BEAT 3 -- BOB JOINS            caption: 12.0s - 18.0s
#   "Bob opens it. The broker relays only the encrypted handshake."
# ============================================================================
log "Bob: opening invitation URL"
npx agent-browser --session bob open "$INVITATION" >/dev/null
npx agent-browser --session bob set viewport 1920 1080 >/dev/null
sleep 4

# ============================================================================
# BEAT 4 -- WAIT FOR CONNECTED   caption: 18.0s - 23.0s
#   "WebRTC data channel open -- the server is now out of the path."
# ============================================================================
log "waiting for both sessions to reach Connected"
if ! wait_for_connected 2 25; then
  log "WARN: did not reach Connected on both sides in 25s (continuing anyway)"
fi
sleep 2

# ============================================================================
# BEAT 5 -- MESSAGE EXCHANGE     caption: 23.0s - 32.0s
#   "Messages are end-to-end encrypted. The server never sees them."
# ============================================================================
log "Alice: sending a message"
# Match the textarea whose aria-label is exactly "Message", not "Send message".
MSG_REF="$(ref_for alice 'textbox.*Message')"
if [[ -n "$MSG_REF" ]]; then
  npx agent-browser --session alice fill "@${MSG_REF}" "hi -- encrypted?" >/dev/null 2>&1 || true
  sleep 1
  SEND_REF="$(ref_for alice 'Send message')"
  [[ -n "$SEND_REF" ]] && npx agent-browser --session alice click "@${SEND_REF}" >/dev/null 2>&1 || true
fi
sleep 2

log "Bob: replying"
MSG_REF_BOB="$(ref_for bob 'textbox.*Message')"
if [[ -n "$MSG_REF_BOB" ]]; then
  npx agent-browser --session bob fill "@${MSG_REF_BOB}" "yep -- server never sees this." >/dev/null 2>&1 || true
  sleep 1
  SEND_REF_BOB="$(ref_for bob 'Send message')"
  [[ -n "$SEND_REF_BOB" ]] && npx agent-browser --session bob click "@${SEND_REF_BOB}" >/dev/null 2>&1 || true
fi
sleep 3

# Bring Alice back into focus for the camera before the final beat.
npx agent-browser --session alice snapshot -i >/dev/null 2>&1 || true

# ============================================================================
# BEAT 6 -- SAFETY NUMBER        caption: 32.0s - 38.0s
#   "Both sides show the same safety number -- verify it out-of-band."
# ============================================================================
log "Alice: opening safety number dialog"
SAFETY_REF="$(ref_for alice 'Review safety number|Safety number')"
if [[ -n "$SAFETY_REF" ]]; then
  npx agent-browser --session alice click "@${SAFETY_REF}" >/dev/null 2>&1 || true
fi
sleep 4

# Stop recording.
log "stopping recorder"
npx agent-browser --session alice record stop >/dev/null 2>&1 || true
RECORDING_STARTED=0
sleep 1

# ---------- 2. burn in captions + compress ----------------------------------
RAW_DUR="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$RAW" 2>/dev/null)"
log "raw recording: ${RAW_DUR}s"

# Caption timing. Keep these in sync with the BEAT comments above.
# Format:  START|END|Text   (single-quoted by the builder below; avoid apostrophes
# inside the text -- use "--" instead, which drawtext renders fine).
build_drawtext() {
  local captions=(
    "1|6|No account. No phone number. Open a link, talk."
    "6|12|Alice starts the chat -- the link is just a random ID."
    "12|18|Bob opens it. The broker relays only the encrypted handshake."
    "18|23|WebRTC data channel open -- the server is now out of the path."
    "23|32|Messages are end-to-end encrypted. The server never sees them."
    "32|38|Both sides show the same safety number -- verify it out-of-band."
  )
  local filter="" first=1 seg
  for entry in "${captions[@]}"; do
    local start end text
    start="${entry%%|*}"; local rest="${entry#*|}"
    end="${rest%%|*}";    text="${rest#*|}"
    # shellcheck disable=SC2016
    seg="drawtext=fontfile='${FONT}':text='${text}':fontsize=44:fontcolor=white:box=1:boxcolor=black@0.72:boxborderw=14:x=(w-text_w)/2:y=h-130:enable='between(t,${start},${end})'"
    if (( first )); then filter="$seg"; first=0; else filter="${filter},${seg}"; fi
  done
  printf '%s' "$filter"
}

FILTER="$(build_drawtext)"

log "rendering captioned + compressed video -> $OUT"
# VP9, CRF 38, 1080p, no audio. -threads 0 = use all cores. row-mt speeds VP9 up.
# Filter chain: scale first (1920x1080), THEN each drawtext as a separate filter,
# joined by COMMAS. (A colon after scale=1920:1080 would parse the drawtext as a
# stray scale option and fail with "Option not found".)
ffmpeg -y -hide_banner -loglevel error \
  -i "$RAW" \
  -vf "scale=1920:1080,${FILTER}" \
  -an \
  -c:v libvpx-vp9 -b:v 0 -crf 38 -row-mt 1 -threads 0 \
  "$OUT"

# ---------- 3. verify --------------------------------------------------------
log "final stats:"
ffprobe -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,width,height \
  -show_entries format=duration,size \
  -of default=noprint_wrappers=1 "$OUT"

SIZE_BYTES="$(stat -c %s "$OUT" 2>/dev/null || echo 0)"
SIZE_KB=$(( SIZE_BYTES / 1024 ))
DUR="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT")"
log "wrote $OUT  (${SIZE_KB} KB, ${DUR}s)"

# Clean up the raw recording unless asked to keep it.
if [[ "$KEEP_RAW" != "1" ]]; then
  rm -f "$RAW"
fi

log "done"
