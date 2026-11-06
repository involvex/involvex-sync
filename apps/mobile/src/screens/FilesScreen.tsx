import { Pressable, ScrollView, Text, View } from "react-native";
import { useSession } from "../sessionContext";
import { useTheme } from "../themeContext";
import { makeStyles } from "../ui/styles";

export function FilesScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const {
    appSettings,
    pickIncomingFolder,
    clearIncomingFolder,
    pickAndSendFile,
    pendingFiles,
    sendPendingFiles,
  } = useSession();

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
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
    </ScrollView>
  );
}
