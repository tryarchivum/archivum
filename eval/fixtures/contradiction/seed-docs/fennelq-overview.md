---
name: fennelq-overview
description: Read first. What fennelq is and how it stores jobs.
metadata: seeded wiki, written from the README
---
# fennelq

fennelq is a small job queue with workers. Jobs are stored in Redis; the connection URL is read from the environment variable `FENNELQ_REDIS_URL`.

See [[retries]] for retry behaviour.
