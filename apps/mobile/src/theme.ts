export type ThemePreference =
  "system" | "light" | "dark" | "amoled" | "hacker" | "monokai" | "github";

export type ResolvedTheme = Exclude<ThemePreference, "system">;

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

export const amoledColors: ThemeColors = {
  background: "#000000",
  card: "#0a0a0a",
  cardBorder: "rgba(255,255,255,0.1)",
  text: "#f2f2f2",
  textMuted: "#9a9a9a",
  textSoft: "#d0d0d0",
  brand: "#9ec1ff",
  accent: "#5b8cff",
  accentSoft: "#d6e4ff",
  inputBg: "#050505",
  inputBorder: "rgba(255,255,255,0.16)",
  placeholder: "#6b6b6b",
  ghostBtn: "#141414",
  segmentBg: "#050505",
  statusLive: "#3dcea2",
  statusIdle: "#6b6b6b",
  statusBusy: "#f0b35a",
  peerChipBg: "rgba(91,140,255,0.22)",
  peerChipText: "#d6e4ff",
  divider: "rgba(255,255,255,0.12)",
  hairline: "rgba(255,255,255,0.1)",
  switchTrackOff: "#333333",
  switchTrackOn: "#5b8cff",
  switchThumb: "#f2f2f2",
  heroGlow: "rgba(91,140,255,0.16)",
  pairWaitBg: "rgba(91,140,255,0.14)",
  pairWaitBorder: "rgba(91,140,255,0.55)",
};

export const hackerColors: ThemeColors = {
  background: "#020805",
  card: "#06140c",
  cardBorder: "rgba(0,255,102,0.16)",
  text: "#c8ffd4",
  textMuted: "#6fb87f",
  textSoft: "#9be0ab",
  brand: "#39ff88",
  accent: "#00ff66",
  accentSoft: "#b8ffc8",
  inputBg: "#031008",
  inputBorder: "rgba(0,255,102,0.28)",
  placeholder: "#4a7a58",
  ghostBtn: "#0c1c12",
  segmentBg: "#031008",
  statusLive: "#00ff66",
  statusIdle: "#4a7a58",
  statusBusy: "#c8ff4a",
  peerChipBg: "rgba(0,255,102,0.18)",
  peerChipText: "#b8ffc8",
  divider: "rgba(0,255,102,0.18)",
  hairline: "rgba(0,255,102,0.14)",
  switchTrackOff: "#244433",
  switchTrackOn: "#00ff66",
  switchThumb: "#c8ffd4",
  heroGlow: "rgba(0,255,102,0.14)",
  pairWaitBg: "rgba(0,255,102,0.1)",
  pairWaitBorder: "rgba(0,255,102,0.55)",
};

export const monokaiColors: ThemeColors = {
  background: "#272822",
  card: "#2f302a",
  cardBorder: "rgba(248,248,242,0.12)",
  text: "#f8f8f2",
  textMuted: "#a6a595",
  textSoft: "#e6e6d8",
  brand: "#66d9ef",
  accent: "#f92672",
  accentSoft: "#f8f8f2",
  inputBg: "#1e1f1a",
  inputBorder: "rgba(248,248,242,0.18)",
  placeholder: "#75715e",
  ghostBtn: "#3a3b34",
  segmentBg: "#1e1f1a",
  statusLive: "#a6e22e",
  statusIdle: "#75715e",
  statusBusy: "#e6db74",
  peerChipBg: "rgba(249,38,114,0.2)",
  peerChipText: "#f8f8f2",
  divider: "rgba(248,248,242,0.14)",
  hairline: "rgba(248,248,242,0.12)",
  switchTrackOff: "#55564d",
  switchTrackOn: "#f92672",
  switchThumb: "#f8f8f2",
  heroGlow: "rgba(249,38,114,0.16)",
  pairWaitBg: "rgba(249,38,114,0.12)",
  pairWaitBorder: "rgba(249,38,114,0.55)",
};

export const githubColors: ThemeColors = {
  background: "#0d1117",
  card: "#161b22",
  cardBorder: "#30363d",
  text: "#e6edf3",
  textMuted: "#8b949e",
  textSoft: "#c9d1d9",
  brand: "#79c0ff",
  accent: "#58a6ff",
  accentSoft: "#79c0ff",
  inputBg: "#010409",
  inputBorder: "#30363d",
  placeholder: "#8b949e",
  ghostBtn: "#21262d",
  segmentBg: "#010409",
  statusLive: "#3fb950",
  statusIdle: "#8b949e",
  statusBusy: "#d29922",
  peerChipBg: "rgba(88,166,255,0.18)",
  peerChipText: "#79c0ff",
  divider: "#30363d",
  hairline: "#21262d",
  switchTrackOff: "#484f58",
  switchTrackOn: "#58a6ff",
  switchThumb: "#e6edf3",
  heroGlow: "rgba(88,166,255,0.14)",
  pairWaitBg: "rgba(88,166,255,0.12)",
  pairWaitBorder: "rgba(88,166,255,0.55)",
};

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

export function colorsForTheme(theme: ResolvedTheme): ThemeColors {
  switch (theme) {
    case "light":
      return lightColors;
    case "amoled":
      return amoledColors;
    case "hacker":
      return hackerColors;
    case "monokai":
      return monokaiColors;
    case "github":
      return githubColors;
    case "dark":
    default:
      return darkColors;
  }
}
