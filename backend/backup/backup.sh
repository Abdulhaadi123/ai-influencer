#!/bin/sh
# Dump the database to S3, then wait a day, forever.
#
# Dumps go to s3://$S3_BUCKET/backups/, encrypted at rest. Nothing here deletes
# old ones — set a lifecycle rule on the bucket (S3 → bucket → Management) to
# expire objects under backups/ after, say, 30 days.
#
# Restore (on the server, from the backend folder):
#   aws s3 cp s3://BUCKET/backups/db-<time>.dump ./restore.dump
#   docker compose exec -T postgres pg_restore --clean --if-exists -U app -d app < restore.dump
set -u

INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

while true; do
  stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  file="/tmp/db-$stamp.dump"

  if pg_dump --format=custom --no-owner --file="$file" "$DATABASE_URL" \
    && aws s3 cp "$file" "s3://$S3_BUCKET/backups/db-$stamp.dump" --sse AES256 --only-show-errors; then
    echo "[backup] saved backups/db-$stamp.dump"
  else
    echo "[backup] FAILED at $stamp" >&2
  fi

  rm -f "$file"
  sleep "$INTERVAL"
done
