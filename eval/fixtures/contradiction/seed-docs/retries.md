---
name: retries
description: How failed jobs are retried and when they are dead-lettered.
metadata: seeded wiki, from the README
---
# Retries

Retries use exponential backoff starting at 2 seconds, doubling each time. A job is dead-lettered after 5 attempts.

Back to [[fennelq-overview]].
