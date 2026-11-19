#!/bin/bash
# The daily backup (plan decision 6). Runs in the `backup` service (the ops image, as /usr/local/bin/mkt-backup),
# started by mkt-backup.timer through mkt-backup.service on the host (docs/operations.md, "Backups"):
#   docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml --profile ops run --rm -T backup
#
# The whole database `mkt` (every schema: pg_dump --format=custom, one consistent snapshot) and the cluster's roles
# (pg_dumpall --roles-only --no-role-passwords), each streamed straight into `age`, encrypted to the owner's
# public key. Nothing is written unencrypted, and the server holds no key that can read the files.
#
# Writes into /backups (the host's /opt/mkt/backups, root 0700):
#   mkt-<UTC timestamp>.dump.age       and  mkt-<ts>.dump.age.sha256
#   mkt-<UTC timestamp>.roles.sql.age  and  mkt-<ts>.roles.sql.age.sha256
# then keeps the newest 7 sets on the server. The off-server copy is offsite.sh, in the `offsite` service, which
# has no database credentials and no route to the database (ruling R18); this service has no route out.
#
# Environment (env files, never the command line):
#   ADMIN_DATABASE_URL    postgres.env: the superuser's address. Split into libpq's PG* variables here, so the
#                         password is never in a process's arguments.
#   BACKUP_AGE_RECIPIENT  backup.env: the owner's age public key (age1...). Missing or blank: refused.
#
# Exits non-zero on any failed step and on a database dump under 1 kB. Each outcome
# is one JSON line; a failure names its step and exit code only. The tools' own messages are not printed (they can
# carry addresses or data); run the step by hand to see one.
set -euo pipefail
umask 077

DIR=/backups
KEEP=7
MIN_DUMP_BYTES=1024
STEP=settings
WORK=$(mktemp -d)
# This run's files, removed if the run fails before the set is complete.
PARTIAL=()

finish() {
  local code=$?
  rm -rf "$WORK"
  if [ "$code" -ne 0 ]; then
    local f
    for f in "${PARTIAL[@]}"; do rm -f "$f" 2>/dev/null || true; done
    printf '{"event":"backup_failed","step":"%s","code":%d}\n' "$STEP" "$code" >&2
  fi
  exit "$code"
}
trap finish EXIT

refuse() {
  printf '{"event":"backup_refused","reason":"%s"}\n' "$1" >&2
  exit 2
}

[ -n "${ADMIN_DATABASE_URL:-}" ] || refuse 'ADMIN_DATABASE_URL is not set'
case "$ADMIN_DATABASE_URL" in *CHANGE_ME*) refuse 'ADMIN_DATABASE_URL still contains CHANGE_ME' ;; esac
case "${BACKUP_AGE_RECIPIENT:-}" in
  age1*) ;;
  '') refuse 'BACKUP_AGE_RECIPIENT is not set: the owner age public key (age1...) goes in backup.env' ;;
  *) refuse 'BACKUP_AGE_RECIPIENT is not an age public key (age1...)' ;;
esac

# libpq reads these; the address itself is not passed to any program. The parts come back through a pipe, never a
# file. Any failure of the parse (a malformed address makes URL() throw, and Node would print the address with
# its password in the error) is caught: nothing is printed, and the script refuses with a fixed reason.
STEP=connection
BAD_URL='ADMIN_DATABASE_URL is not a valid postgres:// address with a host, user and database'
mapfile -t CONN < <(node -e '
  try {
    const u = new URL(process.env.ADMIN_DATABASE_URL)
    const d = decodeURIComponent
    const parts = [u.hostname, u.port || "5432", d(u.username), d(u.pathname.slice(1)), d(u.password)]
    if (!/^postgres(ql)?:$/.test(u.protocol) || !parts[0] || !parts[2] || !parts[3]) process.exit(3)
    if (parts.some((p) => p.includes("\n"))) process.exit(3)
    process.stdout.write(parts.join("\n") + "\n")
  } catch {
    process.exit(3)
  }
' 2>/dev/null || true)
[ "${#CONN[@]}" -eq 5 ] || refuse "$BAD_URL"
PGHOST=${CONN[0]} PGPORT=${CONN[1]} PGUSER=${CONN[2]} PGDATABASE=${CONN[3]} PGPASSWORD=${CONN[4]}
unset CONN
export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
unset ADMIN_DATABASE_URL

# The folder: present, private (no access for group or others), writable.
STEP=folder
[ -d "$DIR" ] || exit 3
MODE=$(stat -c '%a' "$DIR")
[ "${MODE: -2}" = 00 ] || refuse '/backups is open to group or others (mode 0700 expected)'
[ -w "$DIR" ] || exit 3

NAME="mkt-$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$NAME.dump.age"
ROLES="$NAME.roles.sql.age"
PARTIAL=("$DIR/.$DUMP.part" "$DIR/.$ROLES.part" "$DIR/$DUMP" "$DIR/$ROLES" "$DIR/$DUMP.sha256" "$DIR/$ROLES.sha256")

# One snapshot of the whole database. The byte count is of the dump itself, before encryption.
STEP=pg_dump
pg_dump --format=custom --no-password 2>/dev/null \
  | dd bs=1M 2>"$WORK/dd" \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$DIR/.$DUMP.part"
STEP=dump_size
# dd's last line: "<n> bytes (...) copied, ...".
BYTES=$(sed -n 's/^\([0-9][0-9]*\) bytes.*/\1/p' "$WORK/dd")
[ -n "$BYTES" ] || exit 4
[ "$BYTES" -ge "$MIN_DUMP_BYTES" ] || exit 4

STEP=pg_dumpall
pg_dumpall --roles-only --no-role-passwords --no-password -l "$PGDATABASE" 2>/dev/null \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$DIR/.$ROLES.part"

STEP=checksum
mv "$DIR/.$DUMP.part" "$DIR/$DUMP"
mv "$DIR/.$ROLES.part" "$DIR/$ROLES"
(cd "$DIR" && sha256sum "$DUMP" >".$DUMP.sha256.part" && mv ".$DUMP.sha256.part" "$DUMP.sha256")
(cd "$DIR" && sha256sum "$ROLES" >".$ROLES.sha256.part" && mv ".$ROLES.sha256.part" "$ROLES.sha256")
# The set is whole: from here on a failure keeps it.
PARTIAL=()

# The newest $KEEP sets stay on the server; older ones go, all four files of each. Only names this script writes
# are touched.
STEP=retention
mapfile -t SETS < <(cd "$DIR" && for f in mkt-*.dump.age; do
  [[ "$f" =~ ^(mkt-[0-9]{8}T[0-9]{6}Z)\.dump\.age$ ]] && printf '%s\n' "${BASH_REMATCH[1]}"
done | sort -r)
REMOVED=0
for old in "${SETS[@]:KEEP}"; do
  rm -f "$DIR/$old.dump.age" "$DIR/$old.dump.age.sha256" "$DIR/$old.roles.sql.age" "$DIR/$old.roles.sql.age.sha256"
  REMOVED=$((REMOVED + 1))
done

STEP=done
printf '{"event":"backup_done","name":"%s","dump_bytes":%d,"removed":%d}\n' "$NAME" "$BYTES" "$REMOVED"
