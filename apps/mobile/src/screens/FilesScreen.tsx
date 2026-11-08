import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, Switch, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import type { SecretKind } from "@involvex/protocol";
import { saveAppSettings } from "../appSettings";
import {
  KeyboardScreen,
  useScrollInputOnFocus,
} from "../components/KeyboardScreen";
import {
  clearDriveTokens,
  connectGoogleDrive,
  downloadDriveFile,
  ensureDriveAccessToken,
  listDriveFiles,
  loadDriveTokens,
  uploadLocalFile,
  type DriveFileMeta,
  type DriveTokens,
} from "../drive";
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
    setAppSettings,
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
    log,
  } = useSession();

  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | undefined>();
  const [secretLabel, setSecretLabel] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretKind, setSecretKind] = useState<SecretKind>("api_key");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [driveTokens, setDriveTokens] = useState<DriveTokens | null>(null);
  const [driveFiles, setDriveFiles] = useState<DriveFileMeta[]>([]);
  const [driveBusy, setDriveBusy] = useState(false);

  const refreshDriveSession = useCallback(async () => {
    const tokens = await loadDriveTokens();
    setDriveTokens(tokens);
  }, []);

  useEffect(() => {
    void refreshDriveSession();
  }, [refreshDriveSession]);

  const requireDriveToken = async (): Promise<string> => {
    const token = await ensureDriveAccessToken(appSettings.driveOAuthClientId);
    if (!token) {
      throw new Error("Connect Google Drive in Settings first");
    }
    return token;
  };

  const onConnectDrive = async () => {
    try {
      setDriveBusy(true);
      const tokens = await connectGoogleDrive(appSettings.driveOAuthClientId);
      setDriveTokens(tokens);
      log(`drive connected ${tokens.email ?? ""}`.trim());
      Alert.alert(
        "Google Drive",
        `Connected${tokens.email ? ` as ${tokens.email}` : ""}`,
      );
    } catch (e) {
      Alert.alert("Google Drive", String(e));
    } finally {
      setDriveBusy(false);
    }
  };

  const onDisconnectDrive = async () => {
    await clearDriveTokens();
    setDriveTokens(null);
    setDriveFiles([]);
    log("drive disconnected");
  };

  const onUploadToDrive = async () => {
    try {
      setDriveBusy(true);
      const token = await requireDriveToken();
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const asset = picked.assets[0];
      const meta = await uploadLocalFile(token, {
        uri: asset.uri,
        name: asset.name || "upload.bin",
        mimeType: asset.mimeType || "application/octet-stream",
        parentId: appSettings.driveFolderId,
      });
      log(`drive upload ${meta.name || asset.name} (${meta.id})`);
      Alert.alert("Google Drive", `Uploaded ${asset.name}`);
      void onListDrive();
    } catch (e) {
      Alert.alert("Google Drive", String(e));
    } finally {
      setDriveBusy(false);
    }
  };

  const onListDrive = async () => {
    try {
      setDriveBusy(true);
      const token = await requireDriveToken();
      const files = await listDriveFiles(token, appSettings.driveFolderId);
      setDriveFiles(files);
    } catch (e) {
      Alert.alert("Google Drive", String(e));
    } finally {
      setDriveBusy(false);
    }
  };

  const onDownloadDriveFile = async (file: DriveFileMeta) => {
    try {
      setDriveBusy(true);
      const token = await requireDriveToken();
      const cacheRoot = FileSystem.cacheDirectory;
      if (!cacheRoot) throw new Error("no cache directory");
      const dest = `${cacheRoot}drive-${file.id}-${file.name}`;
      const localUri = await downloadDriveFile(token, file.id, dest);
      const folderUri = appSettings.incomingFilesUri;
      if (folderUri) {
        const created = await FileSystem.StorageAccessFramework.createFileAsync(
          folderUri,
          file.name,
          file.mimeType || "application/octet-stream",
        );
        const b64 = await FileSystem.readAsStringAsync(localUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await FileSystem.StorageAccessFramework.writeAsStringAsync(
          created,
          b64,
          { encoding: FileSystem.EncodingType.Base64 },
        );
        log(`drive download → SAF ${file.name}`);
        Alert.alert("Google Drive", `Saved ${file.name} to save folder`);
      } else {
        log(`drive download → cache ${file.name}`);
        Alert.alert(
          "Google Drive",
          `Downloaded to cache. Pick a save folder to keep files.`,
        );
      }
    } catch (e) {
      Alert.alert("Google Drive", String(e));
    } finally {
      setDriveBusy(false);
    }
  };

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

      <View style={styles.card}>
        <Text style={styles.h2}>Google Drive</Text>
        <Text style={styles.muted}>
          {driveTokens
            ? `Signed in${driveTokens.email ? ` as ${driveTokens.email}` : ""}`
            : "Not connected — set OAuth client ID in Settings, then connect."}
        </Text>
        {driveTokens ? (
          <>
            <Pressable
              style={styles.btn}
              disabled={driveBusy}
              onPress={() => void onUploadToDrive()}
            >
              <Text style={styles.btnText}>Upload file to Drive</Text>
            </Pressable>
            <Pressable
              style={styles.btnGhost}
              disabled={driveBusy}
              onPress={() => void onListDrive()}
            >
              <Text style={styles.btnText}>List folder</Text>
            </Pressable>
            <Pressable
              style={styles.linkBtn}
              onPress={() => void onDisconnectDrive()}
            >
              <Text style={styles.linkText}>Disconnect Google</Text>
            </Pressable>
            {driveFiles.map((f) => (
              <View key={f.id} style={{ marginTop: 8, gap: 4 }}>
                <Text style={styles.mono}>{f.name}</Text>
                <Pressable onPress={() => void onDownloadDriveFile(f)}>
                  <Text style={styles.linkText}>Download</Text>
                </Pressable>
              </View>
            ))}
          </>
        ) : (
          <Pressable
            style={styles.btn}
            disabled={driveBusy || !appSettings.driveOAuthClientId.trim()}
            onPress={() => void onConnectDrive()}
          >
            <Text style={styles.btnText}>Connect Google Drive</Text>
          </Pressable>
        )}
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.body}>Prefer Drive uploads</Text>
            <Text style={styles.muted}>
              Highlight Drive actions on this tab (manual upload still required)
            </Text>
          </View>
          <Switch
            value={appSettings.driveUploadEnabled}
            onValueChange={(next) => {
              void saveAppSettings({ driveUploadEnabled: next }).then(
                setAppSettings,
              );
            }}
            trackColor={{
              false: colors.switchTrackOff,
              true: colors.switchTrackOn,
            }}
            thumbColor={colors.switchThumb}
          />
        </View>
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
