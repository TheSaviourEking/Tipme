#!/bin/sh
set -eu

validate_password() {
  variable=$1
  password=$2
  case "$password" in
    ''|*[!A-Za-z0-9_-]*)
      echo "$variable must contain only letters, digits, '-' and '_'" >&2
      exit 2
      ;;
  esac
  if [ "${#password}" -lt 16 ]; then
    echo "$variable must be at least 16 characters" >&2
    exit 2
  fi
}

validate_password POSTGRES_RUNTIME_PASSWORD "$POSTGRES_RUNTIME_PASSWORD"
validate_password POSTGRES_MIGRATOR_PASSWORD "$POSTGRES_MIGRATOR_PASSWORD"
validate_password POSTGRES_BACKUP_PASSWORD "$POSTGRES_BACKUP_PASSWORD"

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  <<SQL
SELECT set_config('tipme.runtime_password', '$POSTGRES_RUNTIME_PASSWORD', false) \\g /dev/null
SELECT set_config('tipme.migrator_password', '$POSTGRES_MIGRATOR_PASSWORD', false) \\g /dev/null
SELECT set_config('tipme.backup_password', '$POSTGRES_BACKUP_PASSWORD', false) \\g /dev/null
\\i /opt/tipme/roles.sql
SQL
