#!/bin/sh
# Runtime guard for coturn: refuse to start when TURN_SHARED_SECRET is unset or
# empty. This is the Dokploy-friendly replacement for the compose-level
# `${TURN_SHARED_SECRET:?...}` fail-fast: Dokploy (and similar runtime-env
# injectors) set env vars INSIDE the container AFTER `docker compose` has
# already resolved interpolation, so a compose-time `:?` would make `docker
# compose up` fail before the container starts — even when Dokploy would
# otherwise inject the secret correctly at run time.
#
# Mounting this script as the service `entrypoint:` makes the guard RUNTIME:
# the container starts, this script runs, and it exits non-zero (with a clear
# log line) when the secret is missing. That is the correct layer at which to
# enforce "no open-relay coturn": if the secret were empty, coturn would
# accept any username/credential pair (or, with `use-auth-secret`, fall back
# to no auth depending on version) — an open TURN relay is a serious abuse
# vector.
#
# When the secret IS set, the script execs the standard coturn binary with the
# original `turnserver` invocation and passes the compose `command:` args
# through unchanged, so the upstream image's default configuration flow is
# preserved (it reads /etc/coturn/turnserver.conf from the mounted config).
#
# POSIX sh (no bashisms): the upstream coturn image is Alpine-based; `set -eu`
# gives us fail-on-error + fail-on-unset-substitution. `:` is the null command
# used to satisfy `set -u` while producing no output.
set -eu

# `set -u` makes an unset `$TURN_SHARED_SECRET` a hard error; we first echo it
# into a normal substitution that tolerates unset/empty (`:-`) so the guard
# produces a clear message rather than a shell-level "unbound variable" trace.
secret=${TURN_SHARED_SECRET:-}

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

# Secret is present: hand off to coturn. `exec` replaces the shell so coturn
# becomes PID 1 and receives SIGTERM directly on `docker stop` (clean shutdown).
# The upstream image's CMD is `turnserver -c /etc/coturn/turnserver.conf
# --log-file=stdout` (see coturn/coturn Dockerfile); we replicate that here
# because overriding `entrypoint:` resets CMD — the docker-compose service
# does not pass a separate `command:`, so the default invocation must live in
# this script.
exec turnserver \
  -c /etc/coturn/turnserver.conf \
  --log-file=stdout \
  "$@"
