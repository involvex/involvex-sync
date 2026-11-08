import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

WebBrowser.maybeCompleteAuthSession();

const TOKEN_KEY = "invx.mobile.drive.token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

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

export function driveRedirectUri(): string {
  return AuthSession.makeRedirectUri({
    scheme: "involvex-sync",
    path: "oauth",
  });
}

/**
 * Interactive Google OAuth for Drive (`drive.file`).
 * Requires an OAuth Android/Web client id from Google Cloud Console.
 */
export async function connectGoogleDrive(
  clientId: string,
): Promise<DriveTokens> {
  const trimmed = clientId.trim();
  if (!trimmed) {
    throw new Error("Set a Google OAuth client ID in Settings first");
  }

  const redirectUri = driveRedirectUri();
  const discovery = {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
  };

  const request = new AuthSession.AuthRequest({
    clientId: trimmed,
    redirectUri,
    scopes: [DRIVE_SCOPE, "openid", "email"],
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    extraParams: {
      access_type: "offline",
      prompt: "consent",
    },
  });

  await request.makeAuthUrlAsync(discovery);
  const result = await request.promptAsync(discovery);
  if (result.type !== "success" || !result.params.code) {
    throw new Error(
      result.type === "dismiss" || result.type === "cancel"
        ? "Sign-in cancelled"
        : "Google sign-in failed",
    );
  }

  const tokenResult = await AuthSession.exchangeCodeAsync(
    {
      clientId: trimmed,
      code: result.params.code,
      redirectUri,
      extraParams: {
        code_verifier: request.codeVerifier ?? "",
      },
    },
    discovery,
  );

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

  // Best-effort email from userinfo.
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

/** Refresh access token when expired; returns null if refresh impossible. */
export async function ensureDriveAccessToken(
  clientId: string,
): Promise<string | null> {
  const tokens = await loadDriveTokens();
  if (!tokens) return null;
  const skewMs = 60_000;
  if (!tokens.expiresAt || tokens.expiresAt > Date.now() + skewMs) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken || !clientId.trim()) {
    return tokens.accessToken;
  }
  try {
    const body = new URLSearchParams({
      client_id: clientId.trim(),
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
