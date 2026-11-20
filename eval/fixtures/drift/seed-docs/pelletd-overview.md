---
name: pelletd-overview
description: Read first. What pelletd is, where it keeps its config, which port it listens on and how clients authenticate.
metadata: seeded wiki, written after the first setup
---
# pelletd

pelletd is a small metrics relay daemon that a dashboard scrapes.

- Config file: `/etc/pelletd/pelletd.conf`
- Listens on port 9100
- Clients authenticate with a shared static key in the `X-Pellet-Key` header

See [[operations]] for starting and restarting it.
