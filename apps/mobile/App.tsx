import { CameraView } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { TabBar, type AppTab } from "./src/components/TabBar";
import { ConnectionScreen } from "./src/screens/ConnectionScreen";
import { FilesScreen } from "./src/screens/FilesScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { SessionProvider, useSession } from "./src/sessionContext";
import { ThemeProvider, useTheme } from "./src/themeContext";
import { makeStyles } from "./src/ui/styles";

function AppShell() {
  const { colors, resolved } = useTheme();
  const styles = makeStyles(colors);
  const {
    finding,
    stopFindPhone,
    scanOpen,
    setScanOpen,
    cameraPermission,
    onScanPayload,
  } = useSession();
  const [tab, setTab] = useState<AppTab>("home");

  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      <StatusBar style={resolved === "dark" ? "light" : "dark"} />
      <Modal visible={finding} animationType="fade" transparent={false}>
        <View style={styles.findRoot}>
          <Text style={styles.findTitle}>Find phone</Text>
          <Text style={styles.findBody}>
            Your PC is looking for this device.
          </Text>
          <Pressable style={styles.btn} onPress={stopFindPhone}>
            <Text style={styles.btnText}>Dismiss</Text>
          </Pressable>
        </View>
      </Modal>
      <Modal visible={scanOpen} animationType="slide" transparent={false}>
        <SafeAreaView style={styles.scanRoot}>
          <Text style={styles.h2}>Scan PC QR</Text>
          <Text style={styles.muted}>
            Point at the pairing QR on the desktop Connection tab.
          </Text>
          {cameraPermission?.granted ? (
            <CameraView
              style={styles.scanCamera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(result) => {
                if (result.data) void onScanPayload(result.data);
              }}
            />
          ) : (
            <Text style={styles.muted}>Camera permission required.</Text>
          )}
          <Pressable style={styles.btnGhost} onPress={() => setScanOpen(false)}>
            <Text style={styles.btnText}>Cancel</Text>
          </Pressable>
        </SafeAreaView>
      </Modal>
      <View style={styles.flex}>
        {tab === "home" ? <HomeScreen /> : null}
        {tab === "connection" ? <ConnectionScreen /> : null}
        {tab === "files" ? <FilesScreen /> : null}
        {tab === "settings" ? <SettingsScreen /> : null}
      </View>
      <TabBar active={tab} onChange={setTab} />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <SessionProvider>
          <AppShell />
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
