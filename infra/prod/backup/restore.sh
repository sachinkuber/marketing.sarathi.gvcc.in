#!/bin/bash
# Restores one backup set (backup.sh) into an empty database. Runs in the `backup` service (the ops image, as
# /usr/local/bin/mkt-restore); docs/operations.md, "Restore", has the whole procedure.
#   restore.sh <mkt-ts.dump.age> <mkt-ts.roles.sql.age> <target-admin-url>
#
# The target address names a superuser and no password (postgres://postgres@host:5432/mkt): the password comes
# from PGPASSWORD (or a .pgpass file) in the environment, so it is in no process's arguments. An address with a
# password is refused. AGE_IDENTITY_FILE is the owner's private key, brought to the machine for the restore only.
#
# Refuses a target that has any table in schema `app`: it restores into an empty database, never over one.
# Steps: the checksums (when the .sha256 files are beside the backups), the roles (created when missing; the
# dump has no passwords, so `ops prepare` gives the run-time roles theirs afterwards), then the dump, in one
# transaction that stops at the first error. Each outcome is one JSON line; a failure names its step and exit
# code only, never the tools' messages (they can carry data).
set -euo pipefail
umask 077

STEP=arguments
finish() {
  local code=$?
  if [ "$code" -ne 0 ]; then printf '{"event":"restore_failed","step":"%s","code":%d}\n' "$STEP" "$code" >&2; fi
  exit "$code"
}
trap finish EXIT

refuse() {
  printf '{"event":"restore_refused","reason":"%s"}\n' "$1" >&2
  exit 2
}

[ "$#" -eq 3 ] || refuse 'usage: restore.sh <dump.age> <roles.sql.age> <target-admin-url>'
DUMP=$1
ROLES=$2
export TARGET=$3
[ -r "$DUMP" ] || refuse 'the dump file is not readable'
[ -r "$ROLES" ] || refuse 'the roles file is not readable'
[ -n "${AGE_IDENTITY_FILE:-}" ] && [ -r "$AGE_IDENTITY_FILE" ] || refuse 'AGE_IDENTITY_FILE is not a readable file'
# Read from the environment, not from node's arguments.
node -e '
  let u
  try { u = new URL(process.env.TARGET) } catch { process.exit(3) }
  if (!/^postgres(ql)?:$/.test(u.protocol)) process.exit(3)
  if (u.password !== "") process.exit(4)
' || case $? in
  4) refuse 'the target address carries a password; give it in PGPASSWORD instead' ;;
  *) refuse 'the target is not a postgres:// address' ;;
esac

STEP=checksum
for f in "$DUMP" "$ROLES"; do
  if [ -f "$f.sha256" ]; then
    (cd "$(dirname "$f")" && sha256sum -c --status "$(basename "$f").sha256") || refuse 'a checksum does not match'
  fi
done

STEP=target
psql_target() { psql -X -q -v ON_ERROR_STOP=1 --no-password --dbname "$TARGET" "$@"; }
TABLES=$(psql_target -At -c "select count(*) from pg_tables where schemaname = 'app'" 2>/dev/null)
[ "$TABLES" = 0 ] || refuse "the target already has $TABLES tables in schema app"

# A role that already exists (the target's superuser, at least) is kept and given the dump's attributes.
STEP=roles
age -d -i "$AGE_IDENTITY_FILE" "$ROLES" \
  | sed -E 's/^CREATE ROLE ([^;]+);$/DO $restore$ BEGIN CREATE ROLE \1; EXCEPTION WHEN duplicate_object THEN NULL; END $restore$;/' \
  | psql_target >/dev/null 2>&1

STEP=pg_restore
age -d -i "$AGE_IDENTITY_FILE" "$DUMP" \
  | pg_restore --exit-on-error --single-transaction --no-password --dbname "$TARGET" >/dev/null 2>&1

STEP=done
TABLES=$(psql_target -At -c "select count(*) from pg_tables where schemaname = 'app'" 2>/dev/null)
printf '{"event":"restored","app_tables":%d,"next":"ops prepare (role passwords)"}\n' "$TABLES"
