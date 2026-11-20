---
name: operations
description: How to start, validate and restart pelletd. Read before changing the running daemon.
metadata: seeded wiki
---
# Operations

Restart with `systemctl restart pelletd`. The health check is `GET /healthz`, which answers `ok` when the key header is accepted.

Back to [[pelletd-overview]].
