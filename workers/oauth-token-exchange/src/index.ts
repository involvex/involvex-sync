/**
 * Google OAuth HTTPS bridge + confidential token exchange.
 * Mirrors awesome-github-app/workers/oauth-token-exchange.
 */

export interface Env {
  GOOGLE_OAUTH_CLIENT_ID_WEB?: string;
  GOOGLE_OAUTH_CLIENT_SECRET_WEB?: string;
  /** Backward-compatible aliases */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
}

const APP_OAUTH_SCHEME = "involvex-sync://oauth";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          service: "involvex-sync-oauth",
          oauth: "/oauth",
          token: "/token",
        },
        { headers: CORS },
      );
    }

    if (url.pathname === "/oauth" || url.pathname === "/oauth/") {
      return oauthBridgeResponse(url);
    }

    if (url.pathname === "/token") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: CORS },
        );
      }
      return tokenExchange(request, env);
    }

    return new Response("not found", { status: 404, headers: CORS });
  },
};

/**
 * Google redirects here (HTTPS — valid on Web clients). Immediately bounce to
 * involvex-sync://oauth?… so Android Custom Tabs can return to the app.
 * The mobile client waits on that scheme via openAuthSessionAsync (not on HTTPS).
 */
function oauthBridgeResponse(url: URL): Response {
  const qs = url.searchParams.toString();
  const deepLink = qs ? `${APP_OAUTH_SCHEME}?${qs}` : APP_OAUTH_SCHEME;
  const err = url.searchParams.get("error");
  const title = err ? "Google sign-in failed" : "Returning to involvex Sync…";
  const safeDeep = deepLink.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=${safeDeep}" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; max-width: 28rem;
           margin: auto; color: #0b1220; background: #f4f6fa; }
    a { color: #3d7eff; word-break: break-all; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>Opening the app…</p>
  <p><a href="${safeDeep}">Open involvex Sync</a></p>
  <script>location.replace(${JSON.stringify(deepLink)});</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    },
  });
}

type TokenExchangeBody = {
  code?: string;
  code_verifier?: string;
  codeVerifier?: string;
  redirect_uri?: string;
  redirectUri?: string;
  client_id?: string;
};

async function tokenExchange(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json<TokenExchangeBody>();

    const code = body.code?.trim();
    const codeVerifier = (body.code_verifier ?? body.codeVerifier)?.trim();
    const redirectUri = (body.redirect_uri ?? body.redirectUri)?.trim();
    const clientId = body.client_id?.trim();

    const pairs = [
      {
        clientId: env.GOOGLE_OAUTH_CLIENT_ID_WEB,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET_WEB,
      },
      {
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      },
    ].filter((p) => p.clientId && p.clientSecret);

    const selected = clientId
      ? pairs.find((p) => p.clientId === clientId)
      : pairs[0];
    const workerClientId = selected?.clientId;
    const workerClientSecret = selected?.clientSecret;

    if (!code) {
      return Response.json(
        { error: "Missing code" },
        { status: 400, headers: CORS },
      );
    }
    if (!workerClientId || !workerClientSecret) {
      return Response.json(
        {
          error: "Worker OAuth credentials are not configured",
          error_description:
            "Set GOOGLE_OAUTH_CLIENT_ID_WEB and GOOGLE_OAUTH_CLIENT_SECRET_WEB (wrangler secret put).",
        },
        { status: 500, headers: CORS },
      );
    }
    if (clientId && clientId !== workerClientId) {
      return Response.json(
        {
          error: "client_id_mismatch",
          error_description:
            "The worker does not have matching credentials for the OAuth client_id used for authorization.",
        },
        { status: 400, headers: CORS },
      );
    }
    if (!codeVerifier) {
      return Response.json(
        {
          error: "missing_code_verifier",
          error_description: "The token request is missing PKCE code_verifier.",
        },
        { status: 400, headers: CORS },
      );
    }
    if (!redirectUri) {
      return Response.json(
        { error: "missing_redirect_uri" },
        { status: 400, headers: CORS },
      );
    }

    const form = new URLSearchParams({
      client_id: workerClientId,
      client_secret: workerClientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data: unknown = await tokenRes.json();
    return Response.json(data, {
      status: tokenRes.status,
      headers: CORS,
    });
  } catch (error) {
    return Response.json(
      { error: "Internal server error", details: String(error) },
      { status: 500, headers: CORS },
    );
  }
}
