# File Routing — nanoclaw

When a file is uploaded, downloaded, or created, route it immediately per the map below and confirm "Moved `file` → `folder/`". Ambiguous → ask first. (Global protocol: ~/.claude/CLAUDE.md "File Routing Protocol".)

## Folder Map (pattern → destination)

| Pattern | Destination |
|---|---|
| Source code | `src/` |
| Docs, guides | `docs/` |
| Utility/maintenance scripts | `scripts/` |
| Container build files | `container/` |
| Deployment configs | `deploy/`, `launchd/` |
| Setup/install flows | `setup/` |
| Images, logos | `assets/` |
| Example configs | `config-examples/` |
| Runtime state (`data/`, `store/`, `groups/`, `logs/`, `repo-tokens/`) | leave alone — runtime-owned, never route files into these |
| Scratch, experiments | session scratchpad — don't add to repo |

## Root policy

OSS-standard root only: `README`, `LICENSE`, `CHANGELOG`, `CONTRIBUTING`, `CLAUDE.md`, config manifests. This repo may be public-facing — no scratch, no secrets, no client material.

## Registration

User-facing changes → `CHANGELOG`; durable facts → auto-memory. `/session-close` sweeps the rest.

## Known cleanup debt (route when touched)

`tmp-dns-*.mjs` at root → `scripts/` or delete if scratch.
