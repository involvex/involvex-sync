import {
  DEFAULT_PORT,
  buildPairingPayload,
  deviceFingerprint,
  looksLikeUrl,
  pairingQrText,
  parseAllowedUrl,
  parsePairingQr,
} from "@involvex/protocol";
import * as Clipboard from "expo-clipboard";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { startKeepalive, stopKeepalive } from "./modules/invx-keepalive/src";
import {
  addShareListener,
  clearSharedText,
  getSharedText,
} from "./modules/invx-share/src";
import {
  type StoredDeviceKeys,
  type StoredPeer,
  clearPeer,
  ensureLocalIdentity,
  loadPeer,
  savePeer,
} from "./src/identity";
import { MobileSession } from "./src/session";
import { type TransportMode, defaultTransport } from "./src/transport";

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

export default function App() {
  const [identity, setIdentity] = useState<StoredDeviceKeys | null>(null);
  const [peer, setPeer] = useState<StoredPeer | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [mode, setMode] = useState<TransportMode>("lan");
  const [pairPaste, setPairPaste] = useState("");
  const [status, setStatus] = useState("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [pairingJson, setPairingJson] = useState("");
  const sessionRef = useRef<MobileSession | null>(null);

  const log = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${stamp}] ${line}`, ...prev].slice(0, 60));
  }, []);

  const openUrlViaNotification = useCallback(
    async (url: string) => {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "Open on phone",
          body: url,
          data: { url },
        },
        trigger: null,
      });
      log(`notification for ${url}`);
    },
    [log],
  );

  useEffect(() => {
    void (async () => {
      await Notifications.requestPermissionsAsync();
      const id = await ensureLocalIdentity("Android");
      setIdentity(id);
      const stored = await loadPeer();
      if (stored) {
        setPeer(stored);
        if (stored.host) setHost(stored.host);
        if (stored.port) setPort(String(stored.port));
      }
    })();
  }, []);

  useEffect(() => {
    if (!identity) return;
    const payload = buildPairingPayload(
      {
        deviceId: identity.deviceId,
        ed25519: identity.ed25519,
        x25519: identity.x25519,
      },
      identity.name,
      "android",
    );
    setPairingJson(pairingQrText(payload));
  }, [identity]);

  const session = useMemo(() => {
    if (!identity) return null;
    const s = new MobileSession(identity, {
      onShareUrl: async (url) => {
        // Background cannot start activities freely — notify then open if possible.
        await openUrlViaNotification(url);
        try {
          await Linking.openURL(url);
        } catch {
          /* user taps notification */
        }
      },
      onClipboard: async (text) => {
        await Clipboard.setStringAsync(text);
        log("clipboard set from desktop");
      },
      onStatus: setStatus,
      onLog: log,
    });
    sessionRef.current = s;
    return s;
  }, [identity, log, openUrlViaNotification]);

  useEffect(() => {
    if (session && peer) session.setPeer(peer);
  }, [session, peer]);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const url = response.notification.request.content.data?.url;
        if (typeof url === "string") {
          void Linking.openURL(url);
        }
      },
    );
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const sub = addShareListener((text) => {
      void handleSharedText(text);
    });
    void getSharedText().then((text) => {
      if (text) void handleSharedText(text);
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSharedText(text: string): Promise<void> {
    const s = sessionRef.current;
    if (!s) return;
    try {
      if (looksLikeUrl(text)) {
        s.sendShareUrl(text);
        log("shared url -> desktop");
      } else {
        s.sendClipboard(text);
        log("shared text → desktop clipboard");
      }
      await clearSharedText();
    } catch (e) {
      log(`share failed: ${String(e)}`);
    }
  }

  function connect(): void {
    if (!session) return;
    const transport = {
      ...defaultTransport(host),
      mode,
      host,
      port: Number(port) || DEFAULT_PORT,
    };
    session.connect(transport);
    void startKeepalive(
      "involvex Sync",
      mode === "lan" ? `LAN ${host}:${port}` : mode,
    );
  }

  function disconnect(): void {
    session?.disconnect();
    void stopKeepalive();
    setStatus("idle");
  }

  async function onPair(): Promise<void> {
    const parsed = parsePairingQr(pairPaste.trim());
    if (!parsed) {
      log("invalid pairing JSON");
      return;
    }
    const next: StoredPeer = {
      deviceId: parsed.device.deviceId,
      name: parsed.device.name,
      deviceType: parsed.device.type,
      ed25519PublicKey: parsed.device.ed25519PublicKey,
      x25519PublicKey: parsed.device.x25519PublicKey,
      host: parsed.host,
      port: parsed.port,
    };
    await savePeer(next);
    setPeer(next);
    if (parsed.host) setHost(parsed.host);
    if (parsed.port) setPort(String(parsed.port));
    log(`paired ${next.name} (${deviceFingerprint(parsed.device)})`);
  }

  async function onUnpair(): Promise<void> {
    await clearPeer();
    session?.clearPeer();
    setPeer(null);
    log("unpaired");
  }

  async function sendClipboardLink(): Promise<void> {
    const text = await Clipboard.getStringAsync();
    const url = parseAllowedUrl(text);
    if (!url) {
      log("clipboard has no http(s) url");
      return;
    }
    sessionRef.current?.sendShareUrl(url);
    log(`sent ${url}`);
  }

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void getSharedText().then((text) => {
          if (text) void handleSharedText(text);
        });
      }
    });
    return () => sub.remove();
  });

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>involvex Sync</Text>
        <Text style={styles.muted}>Status: {status}</Text>

        <View style={styles.card}>
          <Text style={styles.h2}>This phone</Text>
          {identity ? (
            <>
              <Text style={styles.body}>{identity.name}</Text>
              <Text style={styles.mono}>{identity.deviceId}</Text>
              <Text style={styles.mono}>
                fp{" "}
                {deviceFingerprint({
                  deviceId: identity.deviceId,
                  name: identity.name,
                  type: "android",
                  ed25519PublicKey: identity.ed25519.publicKey,
                  x25519PublicKey: identity.x25519.publicKey,
                })}
              </Text>
              <Text style={styles.label}>
                Pairing JSON (paste into desktop)
              </Text>
              <TextInput
                style={[styles.input, styles.multiline]}
                multiline
                value={pairingJson}
                editable={false}
              />
            </>
          ) : (
            <Text style={styles.muted}>Loading…</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>Desktop peer</Text>
          {peer ? (
            <>
              <Text style={styles.body}>
                {peer.name} ({peer.deviceType})
              </Text>
              <Pressable
                style={styles.btnGhost}
                onPress={() => void onUnpair()}
              >
                <Text style={styles.btnText}>Unpair</Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.muted}>Paste desktop QR JSON to pair.</Text>
          )}
          <TextInput
            style={[styles.input, styles.multiline]}
            multiline
            placeholder='{"kind":"involvex-sync-pair",...}'
            placeholderTextColor="#6b7c99"
            value={pairPaste}
            onChangeText={setPairPaste}
          />
          <Pressable style={styles.btn} onPress={() => void onPair()}>
            <Text style={styles.btnText}>Pair</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>Transport</Text>
          <View style={styles.row}>
            {(["lan", "relay", "myfritz"] as TransportMode[]).map((m) => (
              <Pressable
                key={m}
                style={[styles.chip, mode === m && styles.chipOn]}
                onPress={() => setMode(m)}
              >
                <Text style={styles.chipText}>{m}</Text>
              </Pressable>
            ))}
          </View>
          {mode !== "relay" ? (
            <>
              <Text style={styles.label}>Host (LAN IP or myfritz)</Text>
              <TextInput
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="192.168.1.10 or involvex.myfritz.link"
                placeholderTextColor="#6b7c99"
                value={host}
                onChangeText={setHost}
              />
              <Text style={styles.label}>Port</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                value={port}
                onChangeText={setPort}
              />
            </>
          ) : (
            <Text style={styles.muted}>
              Uses wss://sync.involvex.workers.dev (ciphertext only).
            </Text>
          )}
          <View style={styles.row}>
            <Pressable style={styles.btn} onPress={connect}>
              <Text style={styles.btnText}>Connect</Text>
            </Pressable>
            <Pressable style={styles.btnGhost} onPress={disconnect}>
              <Text style={styles.btnText}>Disconnect</Text>
            </Pressable>
          </View>
          <Pressable
            style={styles.btn}
            onPress={() => void sendClipboardLink()}
          >
            <Text style={styles.btnText}>Send clipboard URL</Text>
          </Pressable>
          <Text style={styles.muted}>
            Or use Android Share → involvex Sync while connected.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>Activity</Text>
          {logs.map((line) => (
            <Text key={line} style={styles.mono}>
              {line}
            </Text>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1220" },
  content: { padding: 16, gap: 12 },
  title: {
    color: "#e8eef8",
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  muted: { color: "#9db0cc", marginTop: 4 },
  card: {
    backgroundColor: "rgba(18,28,48,0.95)",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(120,150,200,0.18)",
    gap: 8,
  },
  h2: { color: "#e8eef8", fontSize: 17, fontWeight: "600" },
  body: { color: "#e8eef8" },
  label: { color: "#9db0cc", fontSize: 13, marginTop: 4 },
  mono: {
    color: "#b7c7e0",
    fontFamily: "monospace",
    fontSize: 12,
  },
  input: {
    backgroundColor: "#0a1424",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(120,150,200,0.28)",
    color: "#e8eef8",
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  btn: {
    backgroundColor: "#3d7eff",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  btnGhost: {
    backgroundColor: "#243352",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  btnText: { color: "white", fontWeight: "700" },
  chip: {
    backgroundColor: "#1a2740",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipOn: { backgroundColor: "#3d7eff" },
  chipText: { color: "white", fontWeight: "600", fontSize: 13 },
});
