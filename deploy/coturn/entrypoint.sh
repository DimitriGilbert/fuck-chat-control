#!/bin/sh
# Runtime guard for coturn: refuse to start when TURN_SHARED_SECRET is unset,
# empty, or too short. This is the Dokploy-friendly replacement for the
# compose-level `${TURN_SHARED_SECRET:?...}` fail-fast: Dokploy (and similar
# runtime-env injectors) set env vars INSIDE the container AFTER `docker
# compose` has already resolved interpolation, so a compose-time `:?` would
# make `docker compose up` fail before the container starts — even when
# Dokploy would otherwise inject the secret correctly at run time.
#
# Mounting this script as the service `entrypoint:` makes the guard RUNTIME:
# the container starts, this script runs, and it exits non-zero (with a clear
# log line) when the secret is missing or weak. That is the correct layer at
# which to enforce "no open-relay coturn": if the secret were empty, coturn
# would accept any username/credential pair (or, with `use-auth-secret`, fall
# back to no auth depending on version) — an open TURN relay is a serious
# abuse vector.
#
# SECRET INJECTION — RENDERED CONFIG, NEVER ARGV (R15:F1):
# coturn's config parser does NOT do shell-style $VARIABLE expansion — any
# `$TURN_…` token written into /etc/coturn/turnserver.conf would be taken
# VERBATIM. The mounted config is also read-only, so the secret cannot be
# written there. Passing `--static-auth-secret` on the command line is NOT an
# option either: `/proc/<pid>/cmdline` is world-readable to unprivileged host
# users and execve audit captures argv, so a CLI secret leaks to every
# non-root user on the host.
#
# Instead this script renders a MERGED runtime config inside the container's
# writable layer at /var/lib/coturn/turnserver.runtime.conf: the mounted
# /etc/coturn/turnserver.conf with any existing `static-auth-secret`
# directives STRIPPED — coturn treats that directive as an accumulating list
# (each occurrence adds another accepted secret; it does not override), so an
# operator leftover would otherwise silently stay valid alongside ours —
# plus exactly one `static-auth-secret=<resolved>` line appended. The file is
# created with mode 0600 and exec'd via `turnserver -c`, so the secret never
# appears on argv. The upstream image runs as
# `USER nobody` (uid 65534) — there is no `proc-user` downgrade to worry
# about: the file is owned by the same uid that runs turnserver, and 0600
# means only that uid (and root) can read it. /var/lib/coturn is the image's
# nobody-owned state dir; /etc, /run and the mounted conf are all root-owned
# and not writable here.
#
# Non-secret operator flags (realm, external-ip) still go on argv, built with
# `set --` positional accumulation so values are never word-split or globbed
# (R15:F5).
#
# POSIX sh (no bashisms): the upstream coturn image is Alpine-based; `set -eu`
# gives us fail-on-error + fail-on-unset-substitution.
set -eu

# `set -u` makes an unset `$TURN_SHARED_SECRET` a hard error; we first echo it
# into a normal substitution that tolerates unset/empty (`:-`) so the guard
# produces a clear message rather than a shell-level "unbound variable" trace.
secret=${TURN_SHARED_SECRET:-}
# Realm (R7:F2): deliberately NO default — the previous default
# (turn.fuck-chat-control.eu) leaked the upstream project's identity into
# every self-hoster's TURN allocations. Empty means coturn falls back to its
# own default realm; operators should set TURN_REALM to their own domain.
realm=${TURN_REALM:-}
# External IP (R7/F2): set this to the HOST's public IPv4 when the published
# ports are NAT-forwarded (the common docker deployment). Empty/unset means
# coturn advertises its own listening/relay address as the candidate —
# correct only when the container itself has a public interface; coturn
# performs no NAT public-address detection of its own.
external_ip=${TURN_EXTERNAL_IP:-}

if [ -z "$secret" ]; then
  # stderr so `docker logs` surfaces it prominently (coturn itself logs to
  # stdout via log-file=stdout in turnserver.conf, but this script logs before
  # exec'ing coturn — stderr is the conventional channel for boot guards).
  echo "[coturn-entrypoint] TURN_SHARED_SECRET is unset or empty — refusing to start." >&2
  echo "[coturn-entrypoint] An empty static-auth-secret would let coturn run as an" >&2
  echo "[coturn-entrypoint] open TURN relay (or accept any credential, depending on" >&2
  echo "[coturn-entrypoint] version). Set TURN_SHARED_SECRET in the runtime env" >&2
  echo "[coturn-entrypoint] (Dokploy env vars, .env, or the compose environment)." >&2
  exit 1
fi

# Fail closed on a weak secret (R15:F1). Operators MUST supply a
# TURN_SHARED_SECRET of at least 32 characters, and this script is the
# enforcement point: coturn can be deployed WITHOUT the web service's env
# validation — direct `docker compose up`, bare `docker run`, or an injector
# that only targets the coturn service. A short static-auth-secret weakens
# the HMAC-SHA1 REST-API credential check to brute-forceable; refuse it here
# so the fail-closed posture holds for every deployment path, not just a
# schema-validated one.
if [ "${#secret}" -lt 32 ]; then
  echo "[coturn-entrypoint] TURN_SHARED_SECRET is ${#secret} characters — refusing to start." >&2
  echo "[coturn-entrypoint] The shared secret must be at least 32 characters." >&2
  echo "[coturn-entrypoint] Generate one with e.g. \`openssl rand -hex 32\`." >&2
  exit 1
fi

# The secret is written into a rendered config file below, so it must not
# contain characters that could corrupt the config format: whitespace or
# control characters. A newline would let additional directives be injected
# into the rendered file (e.g. `no-auth`), silently weakening the auth
# posture — reject them rather than sanitize silently. A leading `=` or `"`
# is refused for the same reason: coturn's option parser strips a leading `=`
# and unquotes values, so coturn would silently run with a DIFFERENT secret
# than the one /ice-config mints credentials from.
case "$secret" in
  *[[:space:]]*|*[[:cntrl:]]*|=*|\"*)
    echo "[coturn-entrypoint] TURN_SHARED_SECRET contains whitespace or control" >&2
    echo "[coturn-entrypoint] characters, or starts with '=' or '\"' — refusing to start" >&2
    echo "[coturn-entrypoint] (config-injection / parse-mangling risk)." >&2
    exit 1
    ;;
esac

# ---- Render the merged runtime config ------------------------------------
# /var/lib/coturn is the upstream image's nobody-owned state dir — the
# canonical writable location for coturn runtime files. chmod 700 confines
# the rendered file to the turnserver uid even inside its own dir (the dir
# ships 0755); umask 077 + explicit chmod 600 keep the file unreadable to
# anyone but its owner from the moment it is created. The subshell confines
# the umask change to the write so turnserver inherits the image's default
# umask.
runtime_conf=/var/lib/coturn/turnserver.runtime.conf
mkdir -p /var/lib/coturn
chmod 700 /var/lib/coturn
(
  umask 077
  {
    # Strip any `static-auth-secret` directives an operator may have left in
    # the mounted conf: coturn treats the directive as an accumulating list
    # (each occurrence adds another accepted secret — it does NOT override),
    # so the rendered file must carry exactly ONE: the env-resolved value
    # appended below. awk rather than `grep -v` so a fully-filtered conf is
    # still success while a missing/unreadable conf file remains an error.
    awk '!/^[[:space:]]*static-auth-secret([[:space:]=]|$)/' /etc/coturn/turnserver.conf
    printf '\n# --- runtime-injected by coturn-entrypoint.sh (kept off argv) ---\n'
    printf 'static-auth-secret=%s\n' "$secret"
  } > "$runtime_conf"
)
chmod 600 "$runtime_conf"

# Filter docker-passed args BEFORE appending ours. The compose service sets
# `entrypoint:` but no `command:`, so the upstream image's CMD reaches this
# script verbatim as "$@" — including `--external-ip=$(detect-external-ip)`,
# a shell substitution only the UPSTREAM entrypoint evals. Arriving here
# unevaluated, the literal `$(…)` makes coturn reject the -X value on every
# boot (`Wrong address format`), and any literal -X would also shadow the
# --external-ip appended below. Drop every arg containing a literal `$(`,
# rebuilding "$@" in place (shift off the front, append survivors to the
# back; `argc` bounds the loop to the ORIGINAL arg count).
argc=$#
while [ "$argc" -gt 0 ]; do
  case "$1" in
    *'$('*)
      echo "[coturn-entrypoint] dropping CMD arg with unevaluated substitution: $1" >&2
      ;;
    *)
      set -- "$@" "$1"
      ;;
  esac
  shift
  argc=$((argc - 1))
done

# Accumulate the optional NON-secret CLI flags via `set --` (R15:F5): each
# flag becomes a single positional parameter, so TURN_REALM/TURN_EXTERNAL_IP
# values reach turnserver verbatim — never IFS-split or glob-expanded, and
# safe under `set -u` when empty. Ordering relative to the filtered CMD args
# is irrelevant: turnserver applies all CLI flags after the -c config
# regardless. `--realm`/`--external-ip` are only passed when non-empty so
# coturn falls back to its own defaults rather than receiving an empty string
# (which it would treat as a literal value).
if [ -n "$realm" ]; then
  set -- "$@" --realm="$realm"
fi
if [ -n "$external_ip" ]; then
  echo "[coturn-entrypoint] advertising external-ip=$external_ip for NAT'd relay candidates" >&2
  set -- "$@" --external-ip="$external_ip"
fi

# Secret is present: hand off to coturn. `exec` replaces the shell so coturn
# becomes PID 1 and receives SIGTERM directly on `docker stop` (clean
# shutdown). The upstream image's own entrypoint prepends `turnserver` to the
# image CMD (`--log-file=stdout --external-ip=$(detect-external-ip)`); this
# script replaces that entrypoint, so the CMD reaches us verbatim as "$@"
# (filtered above for its unevaluated `$(…)` substitution) and the explicit
# `-c` pointing at the RENDERED config must live here. The shared secret
# rides in the rendered file (never argv); realm and external-ip ride in "$@"
# as CLI flags, which override config-file values in coturn.
exec turnserver \
  -c "$runtime_conf" \
  --log-file=stdout \
  "$@"
