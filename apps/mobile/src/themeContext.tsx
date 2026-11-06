import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import { loadAppSettings, saveAppSettings } from "./appSettings";
import {
  colorsForMode,
  resolveThemeMode,
  type ThemeColors,
  type ThemePreference,
} from "./theme";

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: "light" | "dark";
  colors: ThemeColors;
  setPreference: (next: ThemePreference) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const systemDark = system !== "light";
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  useEffect(() => {
    void loadAppSettings().then((s) => {
      setPreferenceState(s.theme);
    });
  }, []);

  const setPreference = useCallback(async (next: ThemePreference) => {
    setPreferenceState(next);
    await saveAppSettings({ theme: next });
  }, []);

  const resolved = resolveThemeMode(preference, systemDark);
  const colors = useMemo(() => colorsForMode(resolved), [resolved]);

  const value = useMemo(
    () => ({ preference, resolved, colors, setPreference }),
    [preference, resolved, colors, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
