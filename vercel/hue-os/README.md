# Hue OS Vercel Bridge

This is a shareable Vercel frontend for Hue OS, a Q&A-only personal mirror chat. It must not present itself as a coding agent, deployment runner, git status checker, or task executor.

Important: Vercel cannot reach a private `localhost` on your Mac. To keep using local Claude/Codex subscription CLIs, run the Hue OS local server on your machine and expose it through a controlled HTTPS tunnel or reverse proxy. Then set that public origin on Vercel.

## Local server

```bash
PORT=3847 node ../../ui/server.cjs
```

Expose it with your preferred tunnel, for example Cloudflare Tunnel, Tailscale Funnel, ngrok, or a reverse proxy. The public origin should point to the local server root, e.g. `https://your-tunnel.example`.

## Vercel env

Set:

```bash
HUE_OS_LOCAL_ORIGIN=https://your-public-local-server-origin
```

The Vercel frontend calls `/api/hue-os/login`, `/api/hue-os/profile`, and `/api/hue-os/chat`. Those functions proxy to `${HUE_OS_LOCAL_ORIGIN}/api/replacement-os/*` while forwarding `x-forwarded-for` so the local server can enforce IP-based daily quota.

The deployed Vercel app does **not** run Claude or Codex itself. It only forwards requests to your local Hue OS server, so the actual Claude/Codex subscription login remains on your Mac terminal.

## Deploy

Official Vercel CLI flow: link, set env, preview deploy, verify, then production deploy.

```bash
cd vercel/hue-os
vercel link
vercel env add HUE_OS_LOCAL_ORIGIN production
vercel deploy
# after preview verification only:
vercel deploy --prod
```

Hue OS should refuse access/security-sensitive questions: passwords, tokens, cookies, env values, server/tunnel URLs, auth or quota bypasses, and security-weakening instructions.

Do not deploy to production until the tunnel URL, 4-digit auto-login password flow, quota, and local server are verified.
