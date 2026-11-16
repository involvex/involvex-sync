import type { ResolvedTheme } from "./settings";

/** Same palette shape as mobile `ThemeColors`, mapped onto desktop CSS vars. */
export type ThemePalette = {
  background: string;
  bgGlow: string;
  card: string;
  cardBorder: string;
  text: string;
  textMuted: string;
  textSoft: string;
  brand: string;
  accent: string;
  accent2: string;
  accentSoft: string;
  inputBg: string;
  ghostBtn: string;
  pillBg: string;
  statusLive: string;
  statusIdle: string;
  statusBusy: string;
  statusOk: string;
  pairWaitBg: string;
  pairWaitBorder: string;
  lightOn: string;
  dotOff: string;
  toastShadow: string;
  hint: string;
  errBorder: string;
  okBorder: string;
  link: string;
  colorScheme: "light" | "dark";
};

const dark: ThemePalette = {
  background: "#070d18",
  bgGlow: "#1a2b4d",
  card: "rgba(14, 22, 38, 0.96)",
  cardBorder: "rgba(120, 150, 200, 0.14)",
  text: "#e8eef8",
  textMuted: "#9db0cc",
  textSoft: "#c8d6ec",
  brand: "#7eb0ff",
  accent: "#3d7eff",
  accent2: "#5b8cff",
  accentSoft: "#cfe0ff",
  inputBg: "#0a1424",
  ghostBtn: "#182338",
  pillBg: "#182338",
  statusLive: "#3dcea2",
  statusIdle: "#6b7c99",
  statusBusy: "#f0b35a",
  statusOk: "#6ddea6",
  pairWaitBg: "rgba(61, 126, 255, 0.12)",
  pairWaitBorder: "rgba(61, 126, 255, 0.65)",
  lightOn: "#cfe0ff",
  dotOff: "#3a4a66",
  toastShadow: "rgba(0, 0, 0, 0.35)",
  hint: "#f0b35a",
  errBorder: "rgba(240, 120, 90, 0.55)",
  okBorder: "rgba(61, 206, 162, 0.45)",
  link: "#c8d6ec",
  colorScheme: "dark",
};

const light: ThemePalette = {
  background: "#f4f6fa",
  bgGlow: "#dbe7f8",
  card: "#ffffff",
  cardBorder: "rgba(30, 50, 80, 0.12)",
  text: "#0f172a",
  textMuted: "#5b6b82",
  textSoft: "#334155",
  brand: "#2563eb",
  accent: "#2563eb",
  accent2: "#3b82f6",
  accentSoft: "#1e40af",
  inputBg: "#eef2f7",
  ghostBtn: "#e2e8f0",
  pillBg: "#e8eef6",
  statusLive: "#059669",
  statusIdle: "#94a3b8",
  statusBusy: "#d97706",
  statusOk: "#047857",
  pairWaitBg: "rgba(37, 99, 235, 0.08)",
  pairWaitBorder: "rgba(37, 99, 235, 0.45)",
  lightOn: "#1e40af",
  dotOff: "#cbd5e1",
  toastShadow: "rgba(15, 23, 42, 0.18)",
  hint: "#b45309",
  errBorder: "rgba(220, 80, 60, 0.5)",
  okBorder: "rgba(5, 150, 105, 0.45)",
  link: "#334155",
  colorScheme: "light",
};

const amoled: ThemePalette = {
  background: "#000000",
  bgGlow: "#0a0a14",
  card: "#0a0a0a",
  cardBorder: "rgba(255, 255, 255, 0.1)",
  text: "#f2f2f2",
  textMuted: "#9a9a9a",
  textSoft: "#d0d0d0",
  brand: "#9ec1ff",
  accent: "#5b8cff",
  accent2: "#7aa2ff",
  accentSoft: "#d6e4ff",
  inputBg: "#050505",
  ghostBtn: "#141414",
  pillBg: "#141414",
  statusLive: "#3dcea2",
  statusIdle: "#6b6b6b",
  statusBusy: "#f0b35a",
  statusOk: "#6ddea6",
  pairWaitBg: "rgba(91, 140, 255, 0.14)",
  pairWaitBorder: "rgba(91, 140, 255, 0.55)",
  lightOn: "#d6e4ff",
  dotOff: "#333333",
  toastShadow: "rgba(0, 0, 0, 0.55)",
  hint: "#f0b35a",
  errBorder: "rgba(240, 120, 90, 0.55)",
  okBorder: "rgba(61, 206, 162, 0.45)",
  link: "#d0d0d0",
  colorScheme: "dark",
};

const hacker: ThemePalette = {
  background: "#020805",
  bgGlow: "#0a2818",
  card: "#06140c",
  cardBorder: "rgba(0, 255, 102, 0.16)",
  text: "#c8ffd4",
  textMuted: "#6fb87f",
  textSoft: "#9be0ab",
  brand: "#39ff88",
  accent: "#00ff66",
  accent2: "#39ff88",
  accentSoft: "#b8ffc8",
  inputBg: "#031008",
  ghostBtn: "#0c1c12",
  pillBg: "#0c1c12",
  statusLive: "#00ff66",
  statusIdle: "#4a7a58",
  statusBusy: "#c8ff4a",
  statusOk: "#39ff88",
  pairWaitBg: "rgba(0, 255, 102, 0.1)",
  pairWaitBorder: "rgba(0, 255, 102, 0.55)",
  lightOn: "#b8ffc8",
  dotOff: "#244433",
  toastShadow: "rgba(0, 0, 0, 0.45)",
  hint: "#c8ff4a",
  errBorder: "rgba(255, 80, 80, 0.55)",
  okBorder: "rgba(0, 255, 102, 0.45)",
  link: "#9be0ab",
  colorScheme: "dark",
};

const monokai: ThemePalette = {
  background: "#272822",
  bgGlow: "#3a3b34",
  card: "#2f302a",
  cardBorder: "rgba(248, 248, 242, 0.12)",
  text: "#f8f8f2",
  textMuted: "#a6a595",
  textSoft: "#e6e6d8",
  brand: "#66d9ef",
  accent: "#f92672",
  accent2: "#fd971f",
  accentSoft: "#f8f8f2",
  inputBg: "#1e1f1a",
  ghostBtn: "#3a3b34",
  pillBg: "#3a3b34",
  statusLive: "#a6e22e",
  statusIdle: "#75715e",
  statusBusy: "#e6db74",
  statusOk: "#a6e22e",
  pairWaitBg: "rgba(249, 38, 114, 0.12)",
  pairWaitBorder: "rgba(249, 38, 114, 0.55)",
  lightOn: "#f8f8f2",
  dotOff: "#55564d",
  toastShadow: "rgba(0, 0, 0, 0.4)",
  hint: "#e6db74",
  errBorder: "rgba(249, 38, 114, 0.55)",
  okBorder: "rgba(166, 226, 46, 0.45)",
  link: "#e6e6d8",
  colorScheme: "dark",
};

const github: ThemePalette = {
  background: "#0d1117",
  bgGlow: "#161b22",
  card: "#161b22",
  cardBorder: "#30363d",
  text: "#e6edf3",
  textMuted: "#8b949e",
  textSoft: "#c9d1d9",
  brand: "#79c0ff",
  accent: "#58a6ff",
  accent2: "#79c0ff",
  accentSoft: "#79c0ff",
  inputBg: "#010409",
  ghostBtn: "#21262d",
  pillBg: "#21262d",
  statusLive: "#3fb950",
  statusIdle: "#8b949e",
  statusBusy: "#d29922",
  statusOk: "#3fb950",
  pairWaitBg: "rgba(88, 166, 255, 0.12)",
  pairWaitBorder: "rgba(88, 166, 255, 0.55)",
  lightOn: "#79c0ff",
  dotOff: "#484f58",
  toastShadow: "rgba(0, 0, 0, 0.45)",
  hint: "#d29922",
  errBorder: "rgba(248, 81, 73, 0.55)",
  okBorder: "rgba(63, 185, 80, 0.45)",
  link: "#c9d1d9",
  colorScheme: "dark",
};

export function paletteForTheme(theme: ResolvedTheme): ThemePalette {
  switch (theme) {
    case "light":
      return light;
    case "amoled":
      return amoled;
    case "hacker":
      return hacker;
    case "monokai":
      return monokai;
    case "github":
      return github;
    case "dark":
    default:
      return dark;
  }
}

/** Apply palette tokens onto `document.documentElement` CSS variables. */
export function applyThemePalette(theme: ResolvedTheme): void {
  const p = paletteForTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = p.colorScheme;
  root.style.setProperty("--bg", p.background);
  root.style.setProperty("--bg-glow", p.bgGlow);
  root.style.setProperty("--text", p.text);
  root.style.setProperty("--text-muted", p.textMuted);
  root.style.setProperty("--text-soft", p.textSoft);
  root.style.setProperty("--brand", p.brand);
  root.style.setProperty("--accent", p.accent);
  root.style.setProperty("--accent-2", p.accent2);
  root.style.setProperty("--nav-bg", `${p.background}d9`);
  root.style.setProperty("--card-bg", p.card);
  root.style.setProperty("--border", p.cardBorder);
  root.style.setProperty("--border-strong", p.cardBorder);
  root.style.setProperty("--input-bg", p.inputBg);
  root.style.setProperty("--ghost", p.ghostBtn);
  root.style.setProperty("--pill-bg", p.pillBg);
  root.style.setProperty("--status-live", p.statusLive);
  root.style.setProperty("--status-idle", p.statusIdle);
  root.style.setProperty("--status-busy", p.statusBusy);
  root.style.setProperty("--status-ok", p.statusOk);
  root.style.setProperty("--pair-bg", p.pairWaitBg);
  root.style.setProperty("--pair-border", p.pairWaitBorder);
  root.style.setProperty("--light-on", p.lightOn);
  root.style.setProperty("--dot-off", p.dotOff);
  root.style.setProperty("--toast-shadow", p.toastShadow);
  root.style.setProperty("--hint", p.hint);
  root.style.setProperty("--err-border", p.errBorder);
  root.style.setProperty("--ok-border", p.okBorder);
  root.style.setProperty("--link", p.link);
}
