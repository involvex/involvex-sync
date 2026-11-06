export type ThemePreference = "system" | "light" | "dark";

export type ThemeColors = {
  background: string;
  card: string;
  cardBorder: string;
  text: string;
  textMuted: string;
  textSoft: string;
  brand: string;
  accent: string;
  accentSoft: string;
  inputBg: string;
  inputBorder: string;
  placeholder: string;
  ghostBtn: string;
  segmentBg: string;
  statusLive: string;
  statusIdle: string;
  statusBusy: string;
  peerChipBg: string;
  peerChipText: string;
  divider: string;
  hairline: string;
  switchTrackOff: string;
  switchTrackOn: string;
  switchThumb: string;
  heroGlow: string;
  pairWaitBg: string;
  pairWaitBorder: string;
};

export const darkColors: ThemeColors = {
  background: "#070d18",
  card: "rgba(14,22,38,0.96)",
  cardBorder: "rgba(120,150,200,0.14)",
  text: "#e8eef8",
  textMuted: "#8aa0bf",
  textSoft: "#c8d6ec",
  brand: "#7eb0ff",
  accent: "#3d7eff",
  accentSoft: "#cfe0ff",
  inputBg: "#0a1424",
  inputBorder: "rgba(120,150,200,0.22)",
  placeholder: "#6b7c99",
  ghostBtn: "#182338",
  segmentBg: "#0a1424",
  statusLive: "#3dcea2",
  statusIdle: "#6b7c99",
  statusBusy: "#f0b35a",
  peerChipBg: "rgba(61,126,255,0.2)",
  peerChipText: "#cfe0ff",
  divider: "rgba(120,150,200,0.18)",
  hairline: "rgba(120,150,200,0.16)",
  switchTrackOff: "#243352",
  switchTrackOn: "#3d7eff",
  switchThumb: "#e8eef8",
  heroGlow: "rgba(61,126,255,0.18)",
  pairWaitBg: "rgba(61,126,255,0.12)",
  pairWaitBorder: "rgba(61,126,255,0.55)",
};

export const lightColors: ThemeColors = {
  background: "#f4f6fa",
  card: "#ffffff",
  cardBorder: "rgba(30,50,80,0.12)",
  text: "#0f172a",
  textMuted: "#5b6b82",
  textSoft: "#334155",
  brand: "#2563eb",
  accent: "#2563eb",
  accentSoft: "#1e3a8a",
  inputBg: "#eef2f7",
  inputBorder: "rgba(30,50,80,0.18)",
  placeholder: "#94a3b8",
  ghostBtn: "#e2e8f0",
  segmentBg: "#eef2f7",
  statusLive: "#059669",
  statusIdle: "#94a3b8",
  statusBusy: "#d97706",
  peerChipBg: "rgba(37,99,235,0.12)",
  peerChipText: "#1e40af",
  divider: "rgba(30,50,80,0.12)",
  hairline: "rgba(30,50,80,0.12)",
  switchTrackOff: "#cbd5e1",
  switchTrackOn: "#2563eb",
  switchThumb: "#ffffff",
  heroGlow: "rgba(37,99,235,0.12)",
  pairWaitBg: "rgba(37,99,235,0.08)",
  pairWaitBorder: "rgba(37,99,235,0.45)",
};

export function resolveThemeMode(
  preference: ThemePreference,
  systemDark: boolean,
): "light" | "dark" {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemDark ? "dark" : "light";
}

export function colorsForMode(mode: "light" | "dark"): ThemeColors {
  return mode === "light" ? lightColors : darkColors;
}
