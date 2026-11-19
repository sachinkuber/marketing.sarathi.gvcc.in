#!/bin/bash
# The off-server copy (plan decision 6, ruling R18). Runs in the `offsite` service (the ops image, as
# /usr/local/bin/mkt-offsite), after backup.sh, from mkt-backup.service on the host:
#   docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml --profile ops run --rm -T offsite
#
# The service sees /backups read-only, holds only the remote's settings (offsite.env: no database credential) and
# is on backup_egress only (no route to the database). It copies the newest complete set in /backups (all four
# files present and both checksums holding) to <RCLONE_REMOTE>/daily/, and, when <RCLONE_REMOTE>/monthly/ has no
# set of that set's month yet, to <RCLONE_REMOTE>/monthly/ as well. Retention off the server is the bucket's own
# lifecycle rules (daily/ 30 days, monthly/ 365 days; docs/operations.md, "Backups").
#
# Environment (offsite.env):
#   RCLONE_REMOTE                an rclone remote and path, e.g. r2:mkt-backups/mkt. Unset or blank: nothing is
#                                copied, the run says so and succeeds (until the owner sets it up).
#   RCLONE_CONFIG_<NAME>_*       the remote's settings (rclone reads them itself).
#
# Exits non-zero when there is no complete set and on any failed copy. `--immutable` never overwrites an object
# that differs; it reads (HEAD) each object first, so the key needs read as well as write. Each outcome is one JSON
# line; a failure names its step and exit code only, never rclone's messages.
set -euo pipefail
umask 077

DIR=/backups
STEP=settings

finish() {
  local code=$?
  if [ "$code" -ne 0 ]; then printf '{"event":"offsite_failed","step":"%s","code":%d}\n' "$STEP" "$code" >&2; fi
  exit "$code"
}
trap finish EXIT

if [ -z "${RCLONE_REMOTE:-}" ]; then
  printf '{"event":"offsite_skipped","reason":"RCLONE_REMOTE is not set"}\n'
  exit 0
fi
REMOTE=${RCLONE_REMOTE%/}

# The newest set whose four files are all here and whose checksums hold.
STEP=find_set
NAME=
while IFS= read -r candidate; do
  if (cd "$DIR" && for f in "$candidate.dump.age" "$candidate.roles.sql.age"; do
    [ -f "$f" ] && [ -f "$f.sha256" ] && sha256sum -c --status "$f.sha256" || exit 1
  done) 2>/dev/null; then
    NAME=$candidate
    break
  fi
done < <(cd "$DIR" && for f in mkt-*.dump.age; do
  [[ "$f" =~ ^(mkt-[0-9]{8}T[0-9]{6}Z)\.dump\.age$ ]] && printf '%s\n' "${BASH_REMATCH[1]}"
done | sort -r)
[ -n "$NAME" ] || exit 3
FILES=("$NAME.dump.age" "$NAME.dump.age.sha256" "$NAME.roles.sql.age" "$NAME.roles.sql.age.sha256")

copy_to() {
  local f
  for f in "${FILES[@]}"; do
    rclone copyto --immutable "$DIR/$f" "$1/$f" >/dev/null 2>&1
  done
}

STEP=daily
copy_to "$REMOTE/daily"

# One set a month: the first complete set copied in a month that monthly/ has none of. Named by the set's own UTC
# month, so a missed or failed day is caught up by the next run. A month counts as done only when the last file
# copy_to writes (the roles file's checksum) is there, so a run that failed part-way leaves a partial set that the
# next run completes (`--immutable` leaves the files already there as they are). Only rclone's exit 3 (the folder
# does not exist: the first run) means "none"; any other failure of the listing fails the step.
STEP=monthly
MONTH=${NAME:4:6}
LSF_CODE=0
EXISTING=$(rclone lsf --files-only --include "mkt-$MONTH*.roles.sql.age.sha256" "$REMOTE/monthly" 2>/dev/null) || LSF_CODE=$?
if [ "$LSF_CODE" -ne 0 ] && [ "$LSF_CODE" -ne 3 ]; then exit "$LSF_CODE"; fi
MONTHLY=false
if [ -z "$EXISTING" ]; then
  copy_to "$REMOTE/monthly"
  MONTHLY=true
fi

STEP=done
printf '{"event":"offsite_copied","name":"%s","monthly":%s}\n' "$NAME" "$MONTHLY"
