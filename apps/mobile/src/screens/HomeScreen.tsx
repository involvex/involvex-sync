import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  filterClipboardHistory,
  sortClipboardHistory,
} from "../clipboardHistory";
import { useSession } from "../sessionContext";
import { useTheme } from "../themeContext";
import { makeStyles } from "../ui/styles";

export function HomeScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const {
    status,
    peer,
    identity,
    fp,
    connected,
    history,
    sendClipboardLink,
    resendHistory,
    removeHistory,
    clearHistory,
    toggleHistoryPin,
    log,
  } = useSession();
  const [historyQuery, setHistoryQuery] = useState("");

  const visibleHistory = useMemo(
    () => sortClipboardHistory(filterClipboardHistory(history, historyQuery)),
    [history, historyQuery],
  );

  const statusTone = connected
    ? styles.statusLive
    : status === "idle"
      ? styles.statusIdle
      : styles.statusBusy;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.hero}>
        <View style={styles.heroGlow} />
        <Text style={styles.brand}>involvex</Text>
        <Text style={styles.title}>Sync</Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, statusTone]} />
          <Text style={styles.statusText} numberOfLines={1}>
            {status}
          </Text>
          {peer ? (
            <View style={styles.peerChip}>
              <Text style={styles.peerChipText} numberOfLines={1}>
                {peer.name}
              </Text>
            </View>
          ) : null}
        </View>
        {identity ? (
          <Text style={styles.monoSoft}>fp {fp}</Text>
        ) : (
          <Text style={styles.muted}>Loading identity…</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Clipboard</Text>
        <Text style={styles.muted}>
          Send text or image from the phone clipboard to the PC. Auto sync is
          under Settings.
        </Text>
        <Pressable style={styles.btn} onPress={() => void sendClipboardLink()}>
          <Text style={styles.btnText}>Send clipboard to PC</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Clipboard history</Text>
        <TextInput
          style={styles.input}
          placeholder="Search history…"
          placeholderTextColor={colors.textMuted}
          value={historyQuery}
          onChangeText={setHistoryQuery}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {history.length === 0 ? (
          <Text style={styles.muted}>Nothing yet.</Text>
        ) : visibleHistory.length === 0 ? (
          <Text style={styles.muted}>No matches for that query.</Text>
        ) : (
          visibleHistory.map((entry) => (
            <View key={entry.id} style={styles.historyRow}>
              <Pressable
                style={{ flex: 1 }}
                onPress={() => {
                  if (entry.kind === "image" && entry.imageUri) {
                    void FileSystem.readAsStringAsync(entry.imageUri, {
                      encoding: FileSystem.EncodingType.Base64,
                    })
                      .then((b64) => Clipboard.setImageAsync(b64))
                      .then(() => log("copied image from history"))
                      .catch(() =>
                        Clipboard.setStringAsync(entry.text).then(() =>
                          log("copied image label"),
                        ),
                      );
                    return;
                  }
                  void Clipboard.setStringAsync(entry.text).then(() =>
                    log("copied from history"),
                  );
                }}
              >
                <Text style={styles.historyText} numberOfLines={2}>
                  {entry.pinned ? "📌 " : ""}[{entry.direction}]
                  {entry.kind === "image" ? " 🖼 " : " "}
                  {entry.text}
                </Text>
              </Pressable>
              <Pressable
                style={styles.btnGhostSm}
                onPress={() => void toggleHistoryPin(entry.id)}
              >
                <Text style={styles.btnTextSm}>
                  {entry.pinned ? "Unpin" : "Pin"}
                </Text>
              </Pressable>
              <Pressable
                style={styles.btnGhostSm}
                onPress={() => void resendHistory(entry)}
              >
                <Text style={styles.btnTextSm}>Send</Text>
              </Pressable>
              <Pressable
                style={styles.btnGhostSm}
                onPress={() => void removeHistory(entry.id)}
              >
                <Text style={styles.btnTextSm}>Remove</Text>
              </Pressable>
            </View>
          ))
        )}
        {history.length > 0 ? (
          <Pressable
            style={styles.btnGhost}
            onPress={() => void clearHistory()}
          >
            <Text style={styles.btnTextSm}>Clear history</Text>
          </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}
