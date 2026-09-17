# Daily database dump to S3. The postgres image supplies pg_dump in the same
# major version as the database, which pg_dump requires.
FROM postgres:16-alpine

RUN apk add --no-cache aws-cli

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

USER postgres
CMD ["/usr/local/bin/backup.sh"]
