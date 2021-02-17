#!/bin/bash

LOG_LEVEL="test"
CLEAN=false

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --debug)
      LOG_LEVEL="debug"
      ;;
    --clean)
      CLEAN=true
      ;;
  esac
  shift
done

export NODE_ENV="test"
export SYNC_DATABASE="false"
export SQL_DATABASE="dds_test"
export LOG_LEVEL="$LOG_LEVEL"
export SQL_HOST=${SQL_HOST:=localhost}
export SQL_PORT=${SQL_PORT:=5432}
export SQL_USER=${SQL_USER:=postgres}
export SQL_PASSWORD=${SQL_PASSWORD:=postgres}
export PGPASSWORD=$SQL_PASSWORD
export TYPEORM_CACHE=false

# If the clean flag is passed in, drop the database to start fresh.
if [ "$CLEAN" == true ]; then
  if psql -h "$SQL_HOST" -p "$SQL_PORT" -U "$SQL_USER" -lqt | cut -d \| -f 1 | grep -qw "$SQL_DATABASE"; then
    echo -n "Dropping '$SQL_DATABASE' database... "
    dropdb -h "$SQL_HOST" -p "$SQL_PORT" -U "$SQL_USER" "$SQL_DATABASE"
    echo "success!"
  fi
fi

# Create test database if it doesn't exist.
if ! psql -h "$SQL_HOST" -p "$SQL_PORT" -U "$SQL_USER" -lqt | cut -d \| -f 1 | grep -qw "$SQL_DATABASE"; then
  echo -n "Creating '$SQL_DATABASE' database... "
  createdb -h "$SQL_HOST" -p "$SQL_PORT" -U "$SQL_USER" "$SQL_DATABASE" || {
    echo "failed to create '$SQL_DATABASE' database. Aborting..."
    exit
  }
  echo "success!"

  ../migration-run.sh
fi

npx --silent ts-mocha \
  --project "tsconfig.json" \
  --config "./.mocharc.yml" \
  --exit \
  "./**/*.spec.ts"