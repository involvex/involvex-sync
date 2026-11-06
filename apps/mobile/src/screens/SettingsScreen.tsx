import {
  isA11yServiceGranted,
  openAccessibilitySettings,
  setA11yReceiveEnabled,
} from "../../modules/invx-a11y/src";
import {
  openImeSettings,
  setImeReceiveEnabled,
} from "../../modules/invx-ime/src";
import {
  isNotifyListenerGranted,
  openNotifyListenerSettings,
  setNotifyMirrorEnabled,
} from "../../modules/invx-notify/src";
import {
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { saveAppSettings } from "../appSettings";
import { useSession } from "../sessionContext";
import type { ThemePreference } from "../theme";
import { useTheme } from "../themeContext";
import { makeStyles } from "../ui/styles";

const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export function SettingsScreen() {
  const { colors, preference, setPreference } = useTheme();
  const styles = makeStyles(colors);
  const {
    appSettings,
    setAppSettings,
    imeReceive,
    imeActive,
    setImeReceive,
    imeReceiveRef,
    a11yReceive,
    a11yGranted,
    setA11yReceive,
    setA11yGranted,
    a11yReceiveRef,
    a11yGrantedRef,
    mirrorNotifs,
    listenerGranted,
    setMirrorNotifs,
    setListenerGranted,
    pushKeyboardStatus,
    pwshCmd,
    setPwshCmd,
    runPwshOnPc,
    cmdOutput,
    showActivity,
    setShowActivity,
    logs,
    log,
  } = useSession();

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.card}>
        <Text style={styles.h2}>Theme</Text>
        <Text style={styles.muted}>Appearance for this app.</Text>
        <View style={styles.segment}>
          {THEME_OPTIONS.map((opt) => (
            <Pressable
              key={opt.id}
              style={[
                styles.segmentItem,
                preference === opt.id && styles.segmentOn,
              ]}
              onPress={() => void setPreference(opt.id)}
            >
              <Text
                style={[
                  styles.segmentText,
                  preference === opt.id && styles.segmentTextOn,
                ]}
              >
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Features</Text>
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.body}>Allow remote Termux</Text>
            <Text style={styles.muted}>
              Let the PC run bash via InVx Termux
            </Text>
          </View>
          <Switch
            value={appSettings.allowRemoteTermux}
            onValueChange={(next) => {
              void saveAppSettings({ allowRemoteTermux: next }).then(
                setAppSettings,
              );
              log(next ? "remote termux on" : "remote termux off");
            }}
            trackColor={{
              false: colors.switchTrackOff,
              true: colors.switchTrackOn,
            }}
            thumbColor={colors.switchThumb}
          />
        </View>
        <View style={styles.divider} />
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.body}>Sync Keyboard</Text>
            <Text style={styles.muted}>
              IME {imeActive ? "active" : "inactive"} · enable in Android input
              settings
            </Text>
          </View>
          <Switch
            value={imeReceive}
            onValueChange={(next) => {
              void (async () => {
                await setImeReceiveEnabled(next);
                setImeReceive(next);
                imeReceiveRef.current = next;
                pushKeyboardStatus();
                log(next ? "receive keyboard on" : "receive keyboard off");
              })();
            }}
            trackColor={{
              false: colors.switchTrackOff,
              true: colors.switchTrackOn,
            }}
            thumbColor={colors.switchThumb}
          />
        </View>
        <Pressable
          style={styles.linkBtn}
          onPress={() => void openImeSettings()}
        >
          <Text style={styles.linkText}>Open IME settings</Text>
        </Pressable>
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.body}>Receive via accessibility</Text>
            <Text style={styles.muted}>
              {a11yGranted
                ? "Service on — used when IME is not selected"
                : "Needs Accessibility access (opt-in)"}
            </Text>
          </View>
          <Switch
            value={a11yReceive}
            onValueChange={(next) => {
              void (async () => {
                if (next && !(await isA11yServiceGranted())) {
                  log("enable involvex Sync input in Accessibility");
                  await openAccessibilitySettings();
                  const granted = await isA11yServiceGranted();
                  setA11yGranted(granted);
                  a11yGrantedRef.current = granted;
                  pushKeyboardStatus();
                  return;
                }
                await setA11yReceiveEnabled(next);
                setA11yReceive(next);
                a11yReceiveRef.current = next;
                const granted = await isA11yServiceGranted();
                setA11yGranted(granted);
                a11yGrantedRef.current = granted;
                pushKeyboardStatus();
                log(
                  next
                    ? "a11y keyboard receive on"
                    : "a11y keyboard receive off",
                );
              })();
            }}
            trackColor={{
              false: colors.switchTrackOff,
              true: colors.switchTrackOn,
            }}
            thumbColor={colors.switchThumb}
          />
        </View>
        <Pressable
          style={styles.linkBtn}
          onPress={() => {
            void openAccessibilitySettings().then(async () => {
              const granted = await isA11yServiceGranted();
              setA11yGranted(granted);
              a11yGrantedRef.current = granted;
              pushKeyboardStatus();
            });
          }}
        >
          <Text style={styles.linkText}>
            {a11yGranted
              ? "Manage Accessibility access"
              : "Open Accessibility settings"}
          </Text>
        </Pressable>
        <View style={styles.divider} />
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.body}>Notification mirror</Text>
            <Text style={styles.muted}>
              {listenerGranted ? "Access granted" : "Needs Notification access"}
            </Text>
          </View>
          <Switch
            value={mirrorNotifs}
            onValueChange={(next) => {
              void (async () => {
                if (next && !(await isNotifyListenerGranted())) {
                  log("enable Notification access for involvex Sync");
                  await openNotifyListenerSettings();
                  setListenerGranted(await isNotifyListenerGranted());
                  return;
                }
                await setNotifyMirrorEnabled(next);
                setMirrorNotifs(next);
                setListenerGranted(await isNotifyListenerGranted());
                log(
                  next ? "notification mirror on" : "notification mirror off",
                );
              })();
            }}
            trackColor={{
              false: colors.switchTrackOff,
              true: colors.switchTrackOn,
            }}
            thumbColor={colors.switchThumb}
          />
        </View>
        <Pressable
          style={styles.linkBtn}
          onPress={() => {
            void openNotifyListenerSettings().then(async () => {
              setListenerGranted(await isNotifyListenerGranted());
            });
          }}
        >
          <Text style={styles.linkText}>
            {listenerGranted
              ? "Manage Notification access"
              : "Open Notification access"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Run on PC (PowerShell)</Text>
        <Text style={styles.muted}>
          PC must enable “Allow remote PowerShell”.
        </Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          multiline
          placeholder="Get-Date"
          placeholderTextColor={colors.placeholder}
          value={pwshCmd}
          onChangeText={setPwshCmd}
        />
        <Pressable style={styles.btn} onPress={runPwshOnPc}>
          <Text style={styles.btnText}>Run on PC</Text>
        </Pressable>
        {cmdOutput ? (
          <Text style={styles.mono} selectable>
            {cmdOutput}
          </Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <Pressable
          style={styles.headerRow}
          onPress={() => setShowActivity((v) => !v)}
        >
          <Text style={styles.h2}>Activity</Text>
          <Text style={styles.chevron}>{showActivity ? "▾" : "▸"}</Text>
        </Pressable>
        {showActivity ? (
          logs.map((line) => (
            <Text key={line} style={styles.mono}>
              {line}
            </Text>
          ))
        ) : logs[0] ? (
          <Text style={styles.mono} numberOfLines={1}>
            {logs[0]}
          </Text>
        ) : (
          <Text style={styles.muted}>No events yet.</Text>
        )}
      </View>
    </ScrollView>
  );
}
