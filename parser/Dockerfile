# Arrow flight-log parser service — deployed via Openship (same box as
# self-hosted Supabase). Openship builds with the REPO ROOT as context and
# `-f parser/Dockerfile`, so COPY paths below are repo-root-relative:
#   docker build -f parser/Dockerfile .
# Runtime env: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
#              STORAGE_BUCKET, POLL_INTERVAL_S
FROM python:3.12-slim

WORKDIR /app

COPY parser/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY parser/arrow_parser/ arrow_parser/
COPY parser/run.py parser/watcher.py ./
# host checkouts may have 0600 perms; make readable for the runtime user
RUN chmod -R a+rX /app

# Non-root
RUN useradd -m parser
USER parser

# Watcher never listens on a port; healthcheck = queue poll process alive.
CMD ["python", "watcher.py"]
