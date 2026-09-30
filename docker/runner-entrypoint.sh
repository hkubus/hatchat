#!/bin/sh
# Start the runner as the unprivileged `node` user, owning its workspaces.
#
# Images before this one ran the runner as root, so a `runner-workspaces`
# volume they created is root-owned and the `node` user could not write to it.
# Starting as root just long enough to hand the workspace root over fixes that
# on upgrade; then privileges are dropped for good before the runner starts.
set -eu

root="${HAT_WORKSPACE_ROOT:-/srv/hat/workspaces}"

if [ "$(id -u)" = "0" ]; then
  uid="$(id -u node)"
  gid="$(id -g node)"
  mkdir -p "$root"
  if [ "$(stat -c %u "$root")" != "$uid" ]; then
    echo "hat-runner: handing $root to the node user (created by an older image that ran as root)" >&2
    chown -R "$uid:$gid" "$root"
  fi
  exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"
fi

# Started as some other user (docker run --user ...): nothing to fix, but say
# so plainly instead of failing on the first file a tool writes.
if [ ! -w "$root" ]; then
  echo "hat-runner: $root is not writable by uid $(id -u); chown it to that user, or start the container as root so it can fix it" >&2
  exit 1
fi
exec "$@"
