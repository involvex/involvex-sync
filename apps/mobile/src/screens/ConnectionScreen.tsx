import { DEFAULT_PORT } from "@involvex/protocol";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  KeyboardScreen,
  useScrollInputOnFocus,
} from "../components/KeyboardScreen";
import { useSession } from "../sessionContext";
import { useTheme } from "../themeContext";
import { type TransportMode } from "../transport";
import { makeStyles } from "../ui/styles";

export function ConnectionScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { onFocus: scrollOnFocus } = useScrollInputOnFocus();
  const {
    mode,
    setMode,
    host,
    setHost,
    port,
    setPort,
    persistTransport,
    connected,
    connect,
    disconnect,
    pairingBusy,
    pairingPhase,
    cancelPairing,
    nearby,
    peer,
    peers,
    isPeerOpen,
    pairWithNearby,
    openScanner,
    onUnpair,
    onUnpairAll,
    onUsePeer,
    onConnectPeer,
    showAdvanced,
    setShowAdvanced,
    pairingJson,
    copyPairingJson,
    pairPaste,
    setPairPaste,
    onPair,
    startMdnsBrowse,
    stopMdnsBrowse,
    log,
  } = useSession();

  return (
    <KeyboardScreen contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.h2}>Connection</Text>
        <Text style={styles.muted}>Host and mode are saved on this phone.</Text>
        <View style={styles.segment}>
          {(["lan", "relay", "myfritz"] as TransportMode[]).map((m) => (
            <Pressable
              key={m}
              style={[styles.segmentItem, mode === m && styles.segmentOn]}
              onPress={() => {
                setMode(m);
                persistTransport({ mode: m });
              }}
            >
              <Text
                style={[styles.segmentText, mode === m && styles.segmentTextOn]}
              >
                {m}
              </Text>
            </Pressable>
          ))}
        </View>
        {mode !== "relay" ? (
          <View style={styles.fieldGrid}>
            <View style={styles.fieldGrow}>
              <Text style={styles.label}>Host</Text>
              <TextInput
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="192.168.1.10"
                placeholderTextColor={colors.placeholder}
                value={host}
                onChangeText={(value) => {
                  setHost(value);
                  persistTransport({ host: value });
                }}
                onEndEditing={() => persistTransport({ host })}
                onFocus={scrollOnFocus}
              />
            </View>
            <View style={styles.fieldPort}>
              <Text style={styles.label}>Port</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                value={port}
                onChangeText={(value) => {
                  setPort(value);
                  const n = Number(value);
                  if (n > 0) persistTransport({ port: n });
                }}
                onEndEditing={() =>
                  persistTransport({
                    port: Number(port) || DEFAULT_PORT,
                  })
                }
                onFocus={scrollOnFocus}
              />
            </View>
          </View>
        ) : (
          <Text style={styles.muted}>
            Relay · wss://sync.involvex.workers.dev
          </Text>
        )}
        <View style={styles.row}>
          <Pressable style={[styles.btn, styles.btnFlex]} onPress={connect}>
            <Text style={styles.btnText}>
              {connected ? "Reconnect" : "Connect"}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.btnGhost, styles.btnFlex]}
            onPress={disconnect}
          >
            <Text style={styles.btnText}>Disconnect</Text>
          </Pressable>
        </View>
      </View>

      {pairingBusy ? (
        <View style={[styles.card, styles.pairWait]}>
          <Text style={styles.h2}>Waiting for PC to accept…</Text>
          <Text style={styles.muted}>
            {pairingPhase === "waiting"
              ? "Request sent — Accept on the desktop banner."
              : "Connecting to the PC over LAN…"}
          </Text>
          <Pressable style={styles.btnGhost} onPress={cancelPairing}>
            <Text style={styles.btnText}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.h2}>Nearby</Text>
          <Pressable
            style={styles.btnGhostSm}
            onPress={() => {
              void stopMdnsBrowse().then(() => startMdnsBrowse());
              log("rescanning LAN…");
            }}
          >
            <Text style={styles.btnTextSm}>Rescan</Text>
          </Pressable>
        </View>
        <View style={styles.row}>
          <Pressable
            style={[styles.btn, styles.btnFlex]}
            onPress={() => void openScanner()}
          >
            <Text style={styles.btnText}>Scan PC QR</Text>
          </Pressable>
        </View>
        {nearby.length === 0 ? (
          <Text style={styles.muted}>
            Searching for _invxconnect._tcp on your LAN…
          </Text>
        ) : (
          nearby.map((svc) => {
            const isPaired = peer?.deviceId === svc.deviceId;
            return (
              <View
                key={`${svc.deviceId}-${svc.host}`}
                style={styles.nearbyRow}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.body}>
                    {svc.name}
                    {isPaired ? " · paired" : ""}
                  </Text>
                  <Text style={styles.mono}>
                    {svc.host}:{svc.port}
                  </Text>
                </View>
                <Pressable
                  style={styles.btn}
                  disabled={pairingBusy}
                  onPress={() => pairWithNearby(svc)}
                >
                  <Text style={styles.btnText}>
                    {pairingBusy
                      ? "…"
                      : isPaired
                        ? connected
                          ? "Reconnect"
                          : "Connect"
                        : "Pair"}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )}
        {peers.map((p) => {
          const open = isPeerOpen(p.deviceId);
          return (
            <View key={p.deviceId} style={styles.peerRow}>
              <View style={styles.peerInfo}>
                <Text style={styles.peerName}>
                  {p.name}
                  {p.deviceId === peer?.deviceId ? " · active" : ""}
                </Text>
                <Text style={styles.muted}>
                  {open ? "connected" : "offline"}
                  {p.host ? ` · ${p.host}:${p.port ?? 17391}` : ""}
                </Text>
              </View>
              <View style={styles.peerActions}>
                {p.deviceId !== peer?.deviceId ? (
                  <Pressable
                    style={styles.linkBtn}
                    onPress={() => onUsePeer(p.deviceId)}
                  >
                    <Text style={styles.linkText}>Use</Text>
                  </Pressable>
                ) : null}
                {!open ? (
                  <Pressable
                    style={styles.linkBtn}
                    onPress={() => onConnectPeer(p.deviceId)}
                  >
                    <Text style={styles.linkText}>Connect</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => void onUnpair(p.deviceId)}
                >
                  <Text style={styles.linkText}>Remove</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
        {peers.length > 1 ? (
          <Pressable style={styles.linkBtn} onPress={() => void onUnpairAll()}>
            <Text style={styles.linkText}>Forget all devices</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.card}>
        <Pressable
          style={styles.headerRow}
          onPress={() => setShowAdvanced((v) => !v)}
        >
          <Text style={styles.h2}>Advanced</Text>
          <Text style={styles.chevron}>{showAdvanced ? "▾" : "▸"}</Text>
        </Pressable>
        {showAdvanced ? (
          <>
            <Text style={styles.label}>Your pairing JSON</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              multiline
              value={pairingJson}
              editable={false}
              selectTextOnFocus
              showSoftInputOnFocus={false}
            />
            <Pressable
              style={styles.btnGhost}
              onPress={() => void copyPairingJson()}
            >
              <Text style={styles.btnText}>Copy pairing JSON</Text>
            </Pressable>
            <Text style={styles.label}>Paste desktop JSON</Text>
            <Text style={styles.muted}>
              Prefer Scan PC QR above. Paste only if the camera is unavailable.
            </Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              multiline
              placeholder='{"kind":"involvex-sync-pair",...}'
              placeholderTextColor={colors.placeholder}
              value={pairPaste}
              onChangeText={setPairPaste}
              onFocus={scrollOnFocus}
            />
            <Pressable style={styles.btn} onPress={() => void onPair()}>
              <Text style={styles.btnText}>Pair from JSON</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </KeyboardScreen>
  );
}
