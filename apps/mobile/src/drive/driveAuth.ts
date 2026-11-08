import Constants from "expo-constants";
import * as AuthSession from "expo-auth-session";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

WebBrowser.maybeCompleteAuthSession();

const TOKEN_KEY = "invx.mobile.drive.token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** App scheme AuthSession waits for after the Worker deep-links. */
const APP_RETURN_URI = "involvex-sync://oauth";

type OAuthExtra = {
  webGoogleClientId?: string;
  webRedirectUri?: string;
  webTokenExchangeUrl?: string;
};

function oauthExtra(): OAuthExtra {
  return (Constants.expoConfig?.extra?.oauth ?? {}) as OAuthExtra;
}

/**
 * HTTPS redirect registered on the Google **Web** client.
 * Worker receives this, then deep-links to involvex-sync://oauth.
 */
export function driveRedirectUri(): string {
  return (
    oauthExtra().webRedirectUri?.trim() ||
    "https://involvex-sync-oauth.involvex.workers.dev/oauth"
  );
}

export function driveTokenExchangeUrl(): string {
  return (
    oauthExtra().webTokenExchangeUrl?.trim() ||
    "https://involvex-sync-oauth.involvex.workers.dev/token"
  );
}

/** Prefer Settings override, else app.json / app.config.js. */
export function resolveDriveClientId(settingsClientId?: string): string {
  const fromSettings = settingsClientId?.trim() ?? "";
  if (fromSettings) return fromSettings;
  return oauthExtra().webGoogleClientId?.trim() ?? "";
}

export const DRIVE_OAUTH_REDIRECT_URI = driveRedirectUri();

export type DriveTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
};

export async function loadDriveTokens(): Promise<DriveTokens | null> {
  try {
    const raw = await SecureStore.getItemAsync(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DriveTokens;
    if (!parsed?.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveDriveTokens(tokens: DriveTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
}

export async function clearDriveTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

function codeFromReturnUrl(url: string): string | null {
  try {
    const parsed = Linking.parse(url);
    const code = parsed.queryParams?.code;
    if (typeof code === "string" && code) return code;
    if (Array.isArray(code) && typeof code[0] === "string") return code[0];
  } catch {
    /* fall through */
  }
  try {
    const u = new URL(url.replace(/^([^:]+):\/\//, "https://"));
    return u.searchParams.get("code");
  } catch {
    return null;
  }
}

/**
 * Interactive Google OAuth for Drive (`drive.file`).
 *
 * Android Custom Tabs will not hand an *external* HTTPS redirect back to the
 * app. So: Google gets the HTTPS Worker redirect (registered in GCP); the
 * Worker deep-links to involvex-sync://oauth; WebBrowser waits on that scheme.
 */
export async function connectGoogleDrive(
  settingsClientId?: string,
): Promise<DriveTokens> {
  const clientId = resolveDriveClientId(settingsClientId);
  if (!clientId) {
    throw new Error(
      "Set Web OAuth client ID in Settings (or app.json extra.oauth.webGoogleClientId)",
    );
  }
  if (!/\.apps\.googleusercontent\.com$/i.test(clientId)) {
    throw new Error(
      "Client ID should look like …apps.googleusercontent.com (Web client)",
    );
  }

  const googleRedirectUri = driveRedirectUri();
  const discovery = {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
  };

  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri: googleRedirectUri,
    scopes: [DRIVE_SCOPE, "openid", "email"],
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    extraParams: {
      access_type: "offline",
      prompt: "consent",
    },
  });

  const authUrl = await request.makeAuthUrlAsync(discovery);

  // Wait for app scheme (Worker bounces HTTPS → involvex-sync://oauth?code=…).
  // Do not use request.promptAsync — it waits for the HTTPS URI, which Android
  // never returns to the app (always looks like "cancel").
  const browserResult = await WebBrowser.openAuthSessionAsync(
    authUrl,
    APP_RETURN_URI,
    { createTask: false, showInRecents: true },
  );

  if (browserResult.type !== "success" || !("url" in browserResult)) {
    if (
      browserResult.type === WebBrowser.WebBrowserResultType.DISMISS ||
      browserResult.type === WebBrowser.WebBrowserResultType.CANCEL
    ) {
      throw new Error("Sign-in cancelled");
    }
    throw new Error("Google sign-in failed");
  }

  const code = codeFromReturnUrl(browserResult.url);
  if (!code) {
    throw new Error("Google sign-in returned no code");
  }

  const codeVerifier = request.codeVerifier;
  if (!codeVerifier) {
    throw new Error("Missing PKCE code_verifier");
  }

  const tokenResult = await exchangeViaWorker({
    clientId,
    code,
    codeVerifier,
    redirectUri: googleRedirectUri,
  });

  if (!tokenResult.accessToken) {
    throw new Error("No access token from Google");
  }

  const tokens: DriveTokens = {
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresAt: tokenResult.expiresIn
      ? Date.now() + tokenResult.expiresIn * 1000
      : undefined,
  };

  try {
    const me = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (me.ok) {
      const json = (await me.json()) as { email?: string };
      if (json.email) tokens.email = json.email;
    }
  } catch {
    /* ignore */
  }

  await saveDriveTokens(tokens);
  return tokens;
}

async function exchangeViaWorker(opts: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}> {
  const tokenExchangeUrl = driveTokenExchangeUrl();
  const tokenRes = await fetch(tokenExchangeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: opts.clientId,
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!tokenRes.ok || !tokenData.access_token) {
    const details = [tokenData.error, tokenData.error_description]
      .filter(Boolean)
      .join(": ");
    throw new Error(
      details || `Token exchange failed (status ${tokenRes.status})`,
    );
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
  };
}

/** Refresh access token when expired; returns null if refresh impossible. */
export async function ensureDriveAccessToken(
  settingsClientId?: string,
): Promise<string | null> {
  const tokens = await loadDriveTokens();
  if (!tokens) return null;
  const skewMs = 60_000;
  if (!tokens.expiresAt || tokens.expiresAt > Date.now() + skewMs) {
    return tokens.accessToken;
  }
  const clientId = resolveDriveClientId(settingsClientId);
  if (!tokens.refreshToken || !clientId) {
    // Access token expired and we cannot refresh — force reconnect.
    return null;
  }
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (!json.access_token) return null;
    const next: DriveTokens = {
      ...tokens,
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? tokens.refreshToken,
      expiresAt: json.expires_in
        ? Date.now() + json.expires_in * 1000
        : undefined,
    };
    await saveDriveTokens(next);
    return next.accessToken;
  } catch {
    return null;
  }
}
