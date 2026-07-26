#!/usr/bin/env bash
# scripts/demo-video.sh
#
# Re-runnable demo video generator for fck-chat-control.
#
# Opens two isolated browser sessions (Alice + Bob) against an ALREADY-RUNNING
# dev/preview server, walks through the full private-chat flow (sidebar shell ->
# start -> join -> connect -> exchange messages -> start a 2nd chat -> send a
# file -> verify safety number) while recording Alice's window, then burns in
# timed captions with ffmpeg and writes BOTH a compressed WebM and an animated
# GIF.
#
# It does NOT start or stop the dev server. Boot it yourself first:
#   pnpm dev                                   # serves http://localhost:3001
# then in another terminal:
#   bash scripts/demo-video.sh                 # writes docs/media/chat-demo.{webm,gif}
#
# Re-run any time the UI changes -- the outputs are overwritten in place.
#
# Usage:
#   bash scripts/demo-video.sh
#   BASE_URL=http://localhost:3001/ OUT=docs/media/chat-demo.webm GIF=docs/media/chat-demo.gif bash scripts/demo-video.sh
#
# Env vars (all optional):
#   BASE_URL   server URL to record against    (default http://localhost:3001/)
#   OUT        output webm path                (default docs/media/chat-demo.webm)
#   GIF        output gif path                 (default docs/media/chat-demo.gif)
#   RAW        intermediate raw webm path      (default /tmp/chat-demo-raw.webm)
#   PALETTE    temp palette png path           (default /tmp/chat-demo-palette.png)
#   KEEP_RAW   "1" to keep the raw recording   (default unset)
#   FONT       ttf path for drawtext           (default auto-detected)
#
# Prerequisites (install once):
#   npm i -g agent-browser && agent-browser install      # Chrome for CDP
#   ffmpeg                                                 # captions + compress + gif
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
GIF="${GIF:-$REPO_ROOT/docs/media/chat-demo.gif}"
RAW="${RAW:-/tmp/chat-demo-raw.webm}"
PALETTE="${PALETTE:-/tmp/chat-demo-palette.png}"
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

mkdir -p "$(dirname "$OUT")" "$(dirname "$GIF")"
rm -f "$RAW" "$OUT" "$GIF" "$PALETTE"

# ---------- helpers ----------------------------------------------------------
# Note: do NOT wrap "npx agent-browser" in a shell variable -- word-splitting
# breaks flag parsing. Call it directly each time.

log() { printf '\n\033[1;36m[demo]\033[0m %s\n' "$*"; }

# Close only the browser sessions this script opened. The dev server is the
# caller's responsibility and is NEVER touched here. The palette temp file is
# the only other artifact this script creates and is always removed on exit.
teardown() {
  local code=$?
  log "closing browser sessions"
  npx agent-browser --session alice record stop >/dev/null 2>&1 || true
  npx agent-browser close --all >/dev/null 2>&1 || true
  rm -f "$PALETTE"
  exit "$code"
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

# Dispatch a synthetic drag-drop onto [data-drop-zone="chat"] carrying a tiny
# in-memory File. Mirrors the e2e test at tests/e2e/p2p.spec.ts. Used for the
# file-transfer beat: the native file picker is awkward to drive from CDP, but
# a constructed DataTransfer + DragEvent reaches the same handleDrop handler.
# Usage:  drop_file <session> <name> <mime> <contents>
drop_file() {
  local session="$1" name="$2" mime="$3" contents="$4"
  npx agent-browser --session "$session" evaluate "$(
    cat <<EOF
(() => {
  const file = new File(${contents}, ${name}, { type: ${mime} });
  const zone = document.querySelector("[data-drop-zone='chat']");
  if (!zone) throw new Error("chat drop zone not found");
  const transfer = new DataTransfer();
  Object.defineProperty(transfer, "files", { value: [file], configurable: true });
  const evt = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
  Object.defineProperty(evt, "dataTransfer", { value: transfer, configurable: true });
  zone.dispatchEvent(evt);
  return true;
})()
EOF
  )" 2>/dev/null
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

# Wait for the sidebar's Start button to render. The new shell exposes two
# Start affordances (sidebar + empty-state card); the sidebar is the persistent
# one, so we scope to complementary/<aside> via the snapshot's role text.
wait_for_text alice "Start a conversation" 15 || log "WARN: sidebar start button not found in 15s"

# ============================================================================
# BEAT 1 -- SHELL + LANDING            caption: 1.0s - 6.0s
#   "Private chat, no account. Sidebar, conversations, one window."
# ============================================================================
sleep 5   # let the shell settle on camera

# ============================================================================
# BEAT 2 -- ALICE STARTS + PAKE        caption: 6.0s - 14.0s
#   "Alice starts a chat and protects it with a 6-digit PAKE code."
# ============================================================================
log "Alice: click 'Start a conversation' in the sidebar"
# The snapshot lists the sidebar aside before the empty-state card; ref_for
# returns the first match, which is the sidebar's button. If a future change
# reorders them, scope the grep tighter (complementary.*Start).
START_REF="$(ref_for alice 'Start a conversation')"
if [[ -z "$START_REF" ]]; then
  echo "FATAL: could not find 'Start a conversation' ref" >&2
  exit 4
fi
npx agent-browser --session alice click "@${START_REF}" >/dev/null

# The invitation input appears in the chat-view banner once a conversation is
# active.
wait_for_text alice "Invitation link" 10 || log "WARN: invitation input not found"
sleep 2

# Enable PAKE protection: check the "Protect with a 6-digit code" checkbox in
# the InvitationBanner. This tears down the uncoded conversation and starts a
# fresh one with a CSPRNG-generated 6-digit code appended to the invitation
# link as ~<code>. The code rides in the URL hash, which never reaches the
# server -- the broker only sees the bare conversation id.
log "Alice: enabling PAKE protection (6-digit code)"
PAKE_REF="$(ref_for alice 'Protect.*PAKE|6-digit PAKE')"
if [[ -n "$PAKE_REF" ]]; then
  npx agent-browser --session alice click "@${PAKE_REF}" >/dev/null 2>&1 || true
  # Wait for the PAKE code panel to render so the code is visible on camera.
  wait_for_text alice "PAKE code" 8 || log "WARN: PAKE code panel not found"
else
  log "WARN: could not find PAKE checkbox ref (continuing with uncoded invitation)"
fi
sleep 3

# Read the (now coded) invitation URL Alice generated.
INVITATION="$(npx agent-browser --session alice get value 'input[aria-label="Invitation link"]' 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
if [[ -z "$INVITATION" ]]; then
  echo "FATAL: invitation link is empty" >&2
  exit 5
fi
log "Alice: coded invitation = $INVITATION"

# ============================================================================
# BEAT 3 -- BOB JOINS (CODED)          caption: 14.0s - 20.0s
#   "Bob opens the coded link. The code authenticates the handshake via PAKE."
# ============================================================================
log "Bob: opening coded invitation URL"
npx agent-browser --session bob open "$INVITATION" >/dev/null
npx agent-browser --session bob set viewport 1920 1080 >/dev/null
sleep 4

# ============================================================================
# BEAT 4 -- CONNECTED (PAKE)           caption: 20.0s - 26.0s
#   "PAKE authenticates the handshake -- a malicious broker cannot MITM it."
# ============================================================================
log "waiting for both sessions to reach Connected (PAKE)"
if ! wait_for_connected 2 30; then
  log "WARN: did not reach Connected on both sides in 30s (continuing anyway)"
fi
sleep 2

# ============================================================================
# BEAT 5 -- MESSAGE EXCHANGE           caption: 26.0s - 32.0s
#   "Messages are end-to-end encrypted with per-frame AEAD + replay protection."
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

# Bring Alice back into focus for the camera before the multi-chat beat.
npx agent-browser --session alice snapshot -i >/dev/null 2>&1 || true

# ============================================================================
# BEAT 6 -- SECOND CONVERSATION        caption: 32.0s - 38.0s
#   "Alice starts a second chat. Multiple chats, each isolated."
# ============================================================================
log "Alice: starting a second conversation from the sidebar"
# The sidebar's Start button is still the canonical one. Click it again to
# prove multi-chat: a second session appears in the sidebar and the main pane
# flips to a fresh empty chat ( InvitationBanner reappears ).
START_REF_2="$(ref_for alice 'Start a conversation')"
if [[ -n "$START_REF_2" ]]; then
  npx agent-browser --session alice click "@${START_REF_2}" >/dev/null 2>&1 || true
fi
# Wait for the new invitation banner so the new conversation is visibly active.
wait_for_text alice "Invitation link" 8 || log "WARN: second invitation banner not found"
sleep 4

# Switch back to the first conversation so the file transfer lands on the
# connected session. The sidebar lists sessions newest-first by default; the
# first conversation is the SECOND row. Clicking by row text is brittle, so we
# reuse the helper: snapshot the sidebar and click the row whose preview still
# shows Bob's reply. We accept a best-effort click here -- if it misses, the
# drop in BEAT 7 still dispatches on whatever chat is active.
log "Alice: switching back to the first conversation"
FIRST_REF="$(npx agent-browser --session alice snapshot -i 2>/dev/null \
  | grep -iE 'server never sees this' \
  | grep -oE 'ref=e[0-9]+' \
  | head -1 \
  | sed 's/ref=//')"
if [[ -n "$FIRST_REF" ]]; then
  # The match is inside the row's button; ref_for returned the inner text node's
  # ref. Walk up to the clickable row by clicking the ref anyway -- agent-browser
  # clicks the nearest interactive ancestor.
  npx agent-browser --session alice click "@${FIRST_REF}" >/dev/null 2>&1 || true
  sleep 2
fi

# ============================================================================
# BEAT 7 -- FILE TRANSFER              caption: 38.0s - 44.0s
#   "Files too. Dropped here, sent end-to-end, never stored."
# ============================================================================
log "Alice: sending a small file via synthetic drop"
# Drive a File through handleDrop on [data-drop-zone="chat"]. The eval payload
# is built as a JS expression string; the args are JSON-encoded so quoting is
# safe (contents is a JS array-literal fragment of code units to avoid double
# quoting issues inside the heredoc).
if ! drop_file alice '"shared.txt"' '"text/plain"' '["hello from A"]'; then
  log "WARN: synthetic drop did not return success (continuing anyway)"
fi
sleep 5   # let the attachment card render on camera

# ============================================================================
# BEAT 8 -- SAFETY NUMBER              caption: 44.0s - 50.0s
#   "Both sides show the same safety number -- verify it out-of-band."
# ============================================================================
log "Alice: opening safety number dialog"
SAFETY_REF="$(ref_for alice 'Review safety number|Safety number')"
if [[ -n "$SAFETY_REF" ]]; then
  npx agent-browser --session alice click "@${SAFETY_REF}" >/dev/null 2>&1 || true
fi
sleep 5

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
    "1|6|Private chat, no account. Sidebar, conversations, one window."
    "6|14|Alice starts a chat and protects it with a 6-digit PAKE code."
    "14|20|Bob opens the coded link. The code authenticates the handshake via PAKE."
    "20|26|PAKE authenticates the handshake -- a malicious broker cannot MITM it."
    "26|32|Messages are end-to-end encrypted with per-frame AEAD + replay protection."
    "32|38|Alice starts a second chat. Multiple chats, each isolated."
    "38|44|Files too. Dropped here, sent end-to-end, never stored."
    "44|50|Both sides show the same safety number -- verify it out-of-band."
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

# ---------- 3. render the animated GIF --------------------------------------
# Two-pass palette for quality: pass 1 builds a per-frame diff palette, pass 2
# maps it. 760px wide, 12 fps, no audio, dithered. Targets the README embed --
# small enough to render inline on GitHub while staying legible at the demo's
# ~67s length. The WebM is the canonical full-quality artifact; this GIF is the
# inline preview.
log "rendering animated gif -> $GIF"
# Pass 1: palette from the captioned webm.
ffmpeg -y -hide_banner -loglevel error \
  -i "$OUT" \
  -vf "scale=760:-1:flags=lanczos,palettegen=stats_mode=diff" \
  "$PALETTE"

# Pass 2: map the palette onto the captioned webm.
ffmpeg -y -hide_banner -loglevel error \
  -i "$OUT" -i "$PALETTE" \
  -lavfi "scale=760:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5" \
  -r 12 \
  "$GIF"

rm -f "$PALETTE"

# ---------- 4. verify --------------------------------------------------------
log "final stats:"
log "  webm:"
ffprobe -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,width,height \
  -show_entries format=duration,size \
  -of default=noprint_wrappers=1 "$OUT"
log "  gif:"
ffprobe -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,width,height \
  -show_entries format=duration,size \
  -of default=noprint_wrappers=1 "$GIF"

OUT_SIZE_BYTES="$(stat -c %s "$OUT" 2>/dev/null || echo 0)"
OUT_SIZE_KB=$(( OUT_SIZE_BYTES / 1024 ))
OUT_DUR="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT")"
GIF_SIZE_BYTES="$(stat -c %s "$GIF" 2>/dev/null || echo 0)"
GIF_SIZE_KB=$(( GIF_SIZE_BYTES / 1024 ))
GIF_DUR="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$GIF")"
log "wrote $OUT  (${OUT_SIZE_KB} KB, ${OUT_DUR}s)"
log "wrote $GIF  (${GIF_SIZE_KB} KB, ${GIF_DUR}s)"

# Clean up the raw recording unless asked to keep it. The palette was already
# removed right after pass 2 above.
if [[ "$KEEP_RAW" != "1" ]]; then
  rm -f "$RAW"
fi

log "done"
