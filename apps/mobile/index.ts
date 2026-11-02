// Must run before any @noble / @involvex/protocol import — Hermes has no crypto.
import "react-native-get-random-values";

import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
