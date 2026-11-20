---
name: harbor-overview
description: Read first. What harbor is, where it keeps its config, which port its control API listens on and how clients authenticate.
metadata: seeded wiki, written after the first setup
---
# harbor

harbor is a deploy tool with a small control API.

- Config file: `/etc/harbor/harbor.conf`
- The control API listens on port 7400
- Clients authenticate with a static API key in the `X-Harbor-Key` header

See [[deploys]] for releasing and [[runtime]] for logs and state.
