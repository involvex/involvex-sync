// Must run before any @noble / @involvex/protocol import — Hermes has no crypto.
import "react-native-get-random-values";

import { registerRootComponent } from "expo";
import * as SplashScreen from "expo-splash-screen";
import App from "./App";

void SplashScreen.preventAutoHideAsync().catch(() => {
  /* already prevented or native splash gone */
});

registerRootComponent(App);
