# Arrow flight-log parser service — for Openship deploy (same box as
# self-hosted Supabase). Build from repo root or parser/:
#   docker build -t arrow-parser parser/
# Runtime env: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
#              STORAGE_BUCKET, POLL_INTERVAL_S
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY arrow_parser/ arrow_parser/
COPY run.py watcher.py ./
# host checkouts may have 0600 perms; make readable for the runtime user
RUN chmod -R a+rX /app

# Non-root
RUN useradd -m parser
USER parser

# Watcher never listens on a port; healthcheck = queue poll process alive.
CMD ["python", "watcher.py"]
