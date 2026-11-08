import { useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { SecretKind } from "@involvex/protocol";
import {
  KeyboardScreen,
  useScrollInputOnFocus,
} from "../components/KeyboardScreen";
import { useSession } from "../sessionContext";
import { useTheme } from "../themeContext";
import { makeStyles } from "../ui/styles";

const SECRET_KINDS: SecretKind[] = ["api_key", "password", "token", "text"];

export function FilesScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { onFocus: scrollOnFocus } = useScrollInputOnFocus();
  const {
    appSettings,
    pickIncomingFolder,
    clearIncomingFolder,
    pickAndSendFile,
    pendingFiles,
    sendPendingFiles,
    notes,
    secrets,
    vaultUnlocked,
    saveNote,
    removeNote,
    unlockSecrets,
    lockSecrets,
    enableSecretsVault,
    saveSecret,
    removeSecret,
    revealSecret,
    connected,
  } = useSession();

  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | undefined>();
  const [secretLabel, setSecretLabel] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretKind, setSecretKind] = useState<SecretKind>("api_key");
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const onSaveNote = async () => {
    if (!noteTitle.trim() && !noteBody.trim()) return;
    await saveNote({
      id: editingNoteId,
      title: noteTitle.trim() || "Untitled",
      body: noteBody,
    });
    setNoteTitle("");
    setNoteBody("");
    setEditingNoteId(undefined);
  };

  const onSaveSecret = async () => {
    if (!secretLabel.trim() || !secretValue.trim()) return;
    try {
      await saveSecret({
        label: secretLabel.trim(),
        kind: secretKind,
        value: secretValue,
      });
      setSecretLabel("");
      setSecretValue("");
    } catch (e) {
      Alert.alert("Secrets", String(e));
    }
  };

  return (
    <KeyboardScreen contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.h2}>Files</Text>
        <Text style={styles.muted}>
          {appSettings.incomingFilesUri
            ? `Saves to ${appSettings.incomingFilesLabel || "picked folder"}`
            : "No folder picked — files land in private app storage."}
        </Text>
        <Pressable style={styles.btn} onPress={() => void pickIncomingFolder()}>
          <Text style={styles.btnText}>
            {appSettings.incomingFilesUri
              ? "Change save folder"
              : "Pick save folder (SD / Files)"}
          </Text>
        </Pressable>
        {appSettings.incomingFilesUri ? (
          <Pressable
            style={styles.linkBtn}
            onPress={() => void clearIncomingFolder()}
          >
            <Text style={styles.linkText}>Clear save folder</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={styles.btnGhost}
          onPress={() => void pickAndSendFile()}
        >
          <Text style={styles.btnText}>Send file to PC</Text>
        </Pressable>
      </View>

      {pendingFiles.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.h2}>Pending share</Text>
          {pendingFiles.map((f) => (
            <Text key={f.uri} style={styles.mono}>
              {f.name} ({f.mimeType})
            </Text>
          ))}
          <Pressable style={styles.btn} onPress={() => void sendPendingFiles()}>
            <Text style={styles.btnText}>Send when connected</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.h2}>Notes</Text>
        <Text style={styles.muted}>
          Quick notes sync to your PC when connected
          {connected ? "." : " (offline — will queue)."}
        </Text>
        <TextInput
          style={styles.input}
          placeholder="Title"
          placeholderTextColor={colors.placeholder}
          value={noteTitle}
          onChangeText={setNoteTitle}
          onFocus={scrollOnFocus}
        />
        <TextInput
          style={[styles.input, { minHeight: 72, textAlignVertical: "top" }]}
          placeholder="Note"
          placeholderTextColor={colors.placeholder}
          value={noteBody}
          onChangeText={setNoteBody}
          multiline
          onFocus={scrollOnFocus}
        />
        <Pressable style={styles.btn} onPress={() => void onSaveNote()}>
          <Text style={styles.btnText}>
            {editingNoteId ? "Update note" : "Save note"}
          </Text>
        </Pressable>
        {editingNoteId ? (
          <Pressable
            style={styles.linkBtn}
            onPress={() => {
              setEditingNoteId(undefined);
              setNoteTitle("");
              setNoteBody("");
            }}
          >
            <Text style={styles.linkText}>Cancel edit</Text>
          </Pressable>
        ) : null}
        {notes.map((n) => (
          <View key={n.id} style={{ marginTop: 10, gap: 4 }}>
            <Text style={styles.mono}>{n.title}</Text>
            <Text style={styles.muted} numberOfLines={3}>
              {n.body || "(empty)"}
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Pressable
                onPress={() => {
                  setEditingNoteId(n.id);
                  setNoteTitle(n.title);
                  setNoteBody(n.body);
                }}
              >
                <Text style={styles.linkText}>Edit</Text>
              </Pressable>
              <Pressable onPress={() => void removeNote(n.id)}>
                <Text style={styles.linkText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {notes.length === 0 ? (
          <Text style={styles.muted}>No notes yet.</Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Secrets</Text>
        <Text style={styles.muted}>
          API keys and passwords — encrypted at rest, biometric unlock, syncs
          ciphertext to PC.
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {vaultUnlocked ? (
            <Pressable style={styles.btnGhost} onPress={lockSecrets}>
              <Text style={styles.btnText}>Lock</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.btn} onPress={() => void unlockSecrets()}>
              <Text style={styles.btnText}>Unlock</Text>
            </Pressable>
          )}
          <Pressable
            style={styles.btnGhost}
            onPress={() => void enableSecretsVault()}
          >
            <Text style={styles.btnText}>Enable vault</Text>
          </Pressable>
        </View>

        {vaultUnlocked ? (
          <>
            <TextInput
              style={styles.input}
              placeholder="Label (e.g. OpenAI)"
              placeholderTextColor={colors.placeholder}
              value={secretLabel}
              onChangeText={setSecretLabel}
              onFocus={scrollOnFocus}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {SECRET_KINDS.map((k) => (
                <Pressable
                  key={k}
                  style={secretKind === k ? styles.btn : styles.btnGhost}
                  onPress={() => setSecretKind(k)}
                >
                  <Text style={styles.btnText}>{k}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={styles.input}
              placeholder="Secret value"
              placeholderTextColor={colors.placeholder}
              value={secretValue}
              onChangeText={setSecretValue}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              onFocus={scrollOnFocus}
            />
            <Pressable style={styles.btn} onPress={() => void onSaveSecret()}>
              <Text style={styles.btnText}>Save secret</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.muted}>
            Unlock to add or reveal secret values. Labels stay visible.
          </Text>
        )}

        {secrets.map((s) => (
          <View key={s.id} style={{ marginTop: 10, gap: 4 }}>
            <Text style={styles.mono}>
              {s.label} · {s.kind}
            </Text>
            {revealed[s.id] ? (
              <Text style={styles.muted} selectable>
                {revealed[s.id]}
              </Text>
            ) : (
              <Text style={styles.muted}>••••••••</Text>
            )}
            <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
              <Pressable
                onPress={() => {
                  void (async () => {
                    try {
                      const value = await revealSecret(s);
                      setRevealed((prev) => ({ ...prev, [s.id]: value }));
                    } catch (e) {
                      Alert.alert("Secrets", String(e));
                    }
                  })();
                }}
              >
                <Text style={styles.linkText}>Reveal</Text>
              </Pressable>
              {revealed[s.id] ? (
                <Pressable
                  onPress={() => {
                    const value = revealed[s.id];
                    if (value) void Clipboard.setStringAsync(value);
                  }}
                >
                  <Text style={styles.linkText}>Copy</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => {
                  setRevealed((prev) => {
                    const next = { ...prev };
                    delete next[s.id];
                    return next;
                  });
                  void removeSecret(s.id);
                }}
              >
                <Text style={styles.linkText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {secrets.length === 0 ? (
          <Text style={styles.muted}>No secrets yet.</Text>
        ) : null}
      </View>
    </KeyboardScreen>
  );
}
