import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../themeContext";
import { makeStyles } from "../ui/styles";

export type AppTab = "home" | "connection" | "files" | "settings";

const TABS: { id: AppTab; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "⌂" },
  { id: "connection", label: "Connection", icon: "⇄" },
  { id: "files", label: "Files", icon: "▤" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

type Props = {
  active: AppTab;
  onChange: (tab: AppTab) => void;
};

export function TabBar({ active, onChange }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 6) }]}
    >
      {TABS.map((tab) => {
        const on = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            style={styles.tabItem}
            onPress={() => onChange(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.tabIcon, on && styles.tabIconOn]}>
              {tab.icon}
            </Text>
            <Text style={[styles.tabLabel, on && styles.tabLabelOn]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
