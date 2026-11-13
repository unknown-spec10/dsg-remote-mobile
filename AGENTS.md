# Agent entry point

The repository's agent onboarding guide is **[AGENT.md](AGENT.md)** — read it first.

If you only remember one thing: this checkout is a **DSH Host plugin plus a client module and a
phone SPA**, there is no build step, and the client registration id in `client.js` must equal
`package.json`'s `name` (a scoped rename that skips it breaks Web boot).

Deep dives live in `.agent/` (architecture, development, deployment, phone UI, security,
release, troubleshooting, decisions).
