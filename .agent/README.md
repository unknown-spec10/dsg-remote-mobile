# .agent/ — deep dives

Start with [AGENT.md](../AGENT.md). This directory holds the details behind that short guide.

| File | Read it when |
|---|---|
| [architecture.md](architecture.md) | You need the component/process map, services, frames, lifecycle |
| [development.md](development.md) | You are changing code and need setup, checks, mock server |
| [deployment.md](deployment.md) | You are installing/reloading the plugin in a DSH profile or debugging startup |
| [phone-ui.md](phone-ui.md) | You are changing the SPA, sheets, caching or screenshots |
| [security.md](security.md) | You touch auth, approvals, commands, push, uploads or logging |
| [release.md](release.md) | You bump a version, publish to npm or push a tag |
| [troubleshooting.md](troubleshooting.md) | Something fails (startup, phone unreachable, pairing, commands) |
| [decisions.md](decisions.md) | You wonder why a design is the way it is, or are about to "fix" it |

Keeping this folder current is part of finishing a task. If you learn a failure mode, add it to
`troubleshooting.md` and, when it changes behaviour, record the rationale in `decisions.md`.
