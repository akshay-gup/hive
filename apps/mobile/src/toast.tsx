import Check from "lucide-react-native/dist/esm/icons/check";
import AlertCircle from "lucide-react-native/dist/esm/icons/circle-alert";
import X from "lucide-react-native/dist/esm/icons/x";
import { createContext, useContext } from "react";
import { Pressable, Text, View } from "react-native";
import { colors, fontSize, radius } from "./theme";

/** A short message about something that just happened, and what the person can do about it. */
export interface ToastMessage {
  text: string;
  /** It is a failure, and shown as one. */
  error?: boolean;
  /** What a "Retry" button on the toast does. */
  retry?: () => void;
}

/** The message on screen, if any, and how to put it away. A sheet shows it too, since it covers the page. */
export const ToastContext = createContext<{ toast: ToastMessage | null; clear: () => void }>({
  toast: null,
  clear: () => undefined,
});

/** The message, where it can be seen: `place` is the edge it stands against and how far from it. */
export function ToastBubble({
  toast,
  clear,
  place,
}: {
  toast: ToastMessage;
  clear: () => void;
  place: { top: number } | { bottom: number };
}) {
  return (
    <View
      pointerEvents="box-none"
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={{ position: "absolute", left: 20, right: 20, alignItems: "center", ...place }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          padding: 14,
          backgroundColor: colors.inverse,
          borderRadius: radius.lg,
          maxWidth: 560,
        }}
      >
        {toast.error ? (
          <AlertCircle size={16} color={colors.onInverse} />
        ) : (
          <Check size={16} color={colors.onInverse} />
        )}
        <Text style={{ color: colors.onInverse, fontSize: fontSize.small, flexShrink: 1 }}>
          {toast.text}
        </Text>
        {toast.retry && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            hitSlop={10}
            onPress={() => {
              const again = toast.retry;
              clear();
              again?.();
            }}
          >
            <Text
              style={{
                color: colors.onInverse,
                fontSize: fontSize.small,
                fontWeight: "700",
                textDecorationLine: "underline",
              }}
            >
              Retry
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          hitSlop={12}
          onPress={clear}
        >
          <X size={16} color={colors.onInverse} />
        </Pressable>
      </View>
    </View>
  );
}

/** The message on screen, from inside a sheet. */
export function SheetToast({ top }: { top: number }) {
  const { toast, clear } = useContext(ToastContext);
  return toast ? <ToastBubble toast={toast} clear={clear} place={{ top }} /> : null;
}
