# involvex-sync-oauth

Cloudflare Worker for Google Drive OAuth:

1. **GET /oauth** — Google redirects here (HTTPS). Page deep-links to
   `involvex-sync://oauth?code=…`. The app’s `openAuthSessionAsync` waits on
   that **app scheme** (Android never returns an external HTTPS redirect).
2. **POST /token** — exchanges `code` + PKCE `code_verifier` using the Web
   client secret (never shipped in the APK).

Same shape as `awesome-github-app/workers/oauth-token-exchange`.

## Google Cloud Console

Web OAuth client → Authorized redirect URIs:

```
https://involvex-sync-oauth.involvex.workers.dev/oauth
http://localhost:8787/oauth
```

Do **not** add `involvex-sync://oauth` on a Web client — Google rejects custom schemes there.

## Setup

1. Copy `.env.example` → `.env`
2. Fill Web client id + secret
3. Secrets must match `extra.oauth.webGoogleClientId` in the mobile app

```bash
bun install
bun run dev          # http://127.0.0.1:8787
```

## Deploy

```bash
# local .env
bun run deploy

# or production secrets
wrangler secret put GOOGLE_OAUTH_CLIENT_ID_WEB
wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET_WEB
bun run deploy:prod
```

URL: `https://involvex-sync-oauth.involvex.workers.dev`

## POST /token

```json
{
  "code": "…",
  "code_verifier": "…",
  "redirect_uri": "https://involvex-sync-oauth.involvex.workers.dev/oauth",
  "client_id": "….apps.googleusercontent.com"
}
```

Response is Google’s token JSON (`access_token`, `refresh_token`, …).
