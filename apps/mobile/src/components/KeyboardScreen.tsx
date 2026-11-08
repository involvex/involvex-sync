import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  findNodeHandle,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type FocusEventLike = {
  target?: unknown;
  nativeEvent?: { target?: unknown };
};

type ScrollIntoView = (e: FocusEventLike) => void;

/** Active screen registers its scroller; TextInputs call this on focus. */
let activeScrollIntoView: ScrollIntoView = () => {
  /* no KeyboardScreen mounted */
};

/** Wire to TextInput `onFocus` so the field scrolls above the keyboard. */
export function useScrollInputOnFocus(): {
  onFocus: ScrollIntoView;
} {
  return {
    onFocus: (e) => {
      activeScrollIntoView(e);
    },
  };
}

type Props = {
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
};

type ScrollHandle = {
  scrollResponderScrollNativeHandleToKeyboard?: (
    nodeHandle: number,
    additionalOffset: number,
    preventNegativeScrollOffset?: boolean,
  ) => void;
};

function scrollFocusedIntoView(scroll: ScrollHandle | null, e: FocusEventLike) {
  const target = e.target ?? e.nativeEvent?.target;
  const node = typeof target === "number" ? target : findNodeHandle(target);
  if (node == null || !scroll) return;

  const run = () => {
    scroll.scrollResponderScrollNativeHandleToKeyboard?.(node, 120, true);
  };

  // Wait for the keyboard animation / window resize before scrolling.
  setTimeout(run, Platform.OS === "ios" ? 50 : 120);
}

export function KeyboardScreen({ children, contentContainerStyle }: Props) {
  const scrollRef = useRef<ScrollHandle | null>(null);
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, (ev) => {
      setKeyboardHeight(ev.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const onFocus = useCallback((e: FocusEventLike) => {
    scrollFocusedIntoView(scrollRef.current, e);
  }, []);

  useEffect(() => {
    activeScrollIntoView = onFocus;
    return () => {
      if (activeScrollIntoView === onFocus) {
        activeScrollIntoView = () => {
          /* cleared */
        };
      }
    };
  }, [onFocus]);

  // Extra inset while the keyboard is open so the last fields can clear it.
  const keyboardPad =
    keyboardHeight > 0
      ? Platform.OS === "ios"
        ? Math.max(0, keyboardHeight - insets.bottom - 48)
        : 28
      : 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? insets.top : 0}
    >
      <ScrollView
        ref={(node) => {
          scrollRef.current = node;
        }}
        style={{ flex: 1 }}
        contentContainerStyle={[
          contentContainerStyle,
          keyboardPad > 0 ? { paddingBottom: keyboardPad + 32 } : null,
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        automaticallyAdjustKeyboardInsets
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
