import type { LucideIcon } from "lucide-react-native";
import ArrowUpRight from "lucide-react-native/dist/esm/icons/arrow-up-right";
import Check from "lucide-react-native/dist/esm/icons/check";
import ChevronRight from "lucide-react-native/dist/esm/icons/chevron-right";
import Plus from "lucide-react-native/dist/esm/icons/plus";
import Search from "lucide-react-native/dist/esm/icons/search";
import X from "lucide-react-native/dist/esm/icons/x";
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  useWindowDimensions,
  View,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBackToClose } from "./browser-history";
import { LiquidTrack } from "./liquid-track";
import {
  colors,
  fontFamily,
  fontSize,
  glass,
  haze,
  mascotTints,
  radius,
  shadow,
  sp,
  type,
} from "./theme";

export {
  avatarTints,
  brand,
  chart,
  colors,
  eventColors,
  financeArt,
  fontFamily,
  fontSize,
  glass,
  haze,
  layout,
  mascotTints,
  radius,
  shadow,
  sp,
  type,
} from "./theme";

export type GlassKind = "panel" | "bar" | "raised" | "sheet";
/**
 * The fill of a surface: solid, with no blur and no gradient. Only a sheet floats over the page, so
 * only a sheet has a shadow; the rest are told apart by their fill and a hairline.
 */
export function glassSurface(kind: GlassKind): ViewStyle {
  return {
    backgroundColor: glass[kind],
    ...(kind === "sheet" ? { boxShadow: shadow.popover } : null),
  };
}
/**
 * A panel: the sidebar, a channel, a thread, the main area. Panels meet edge to edge. Each draws a
 * hairline down its left edge, which is the divider between it and whatever sits beside it.
 */
export const panelStyle: ViewStyle = {
  ...glassSurface("panel"),
  borderLeftWidth: 1,
  borderLeftColor: colors.line,
  overflow: "hidden",
};
/**
 * A bar or pill: the phone's header and tab bar, and the composer. It has the bar fill. `glass={false}`
 * draws no fill, for a bar that only has one on some layouts. The shape (`borderRadius`) and the
 * border come from `style`, as for a View.
 */
export function GlassBar({
  kind,
  glass: filled = true,
  style,
  children,
  ...rest
}: ViewProps & { kind: "bar" | "raised"; glass?: boolean }) {
  return (
    <View style={[filled && glassSurface(kind), style]} {...rest}>
      {children}
    </View>
  );
}
/** The flat colour behind the panels. Put it first inside a screen-sized view. */
export function Backdrop() {
  return (
    <View
      pointerEvents="none"
      aria-hidden
      style={[StyleSheet.absoluteFill, { backgroundColor: haze.base }]}
    />
  );
}

/**
 * Whether a pointer is over an element, as the browser says it: `mouseenter` and `mouseleave` do not
 * fire when the pointer moves onto something inside. A pressable's own hover state does end then (React
 * Native for the web takes it away while the pointer is on a pressable inside it), so anything that
 * shows buttons on hover must use this on the thing that holds the buttons, not `onHoverIn`/`hovered`.
 */
export function useOver<T = View>() {
  const ref = useRef<T>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current as unknown as {
      addEventListener?: (name: string, run: () => void) => void;
      removeEventListener?: (name: string, run: () => void) => void;
    } | null;
    if (Platform.OS !== "web" || !el?.addEventListener) return;
    const enter = () => setOver(true);
    const leave = () => setOver(false);
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    return () => {
      el.removeEventListener?.("mouseenter", enter);
      el.removeEventListener?.("mouseleave", leave);
    };
  }, []);
  return { ref, over };
}

/** The code font for this platform. Courier, the default on web, is thin and hard to read. */
export const monoFont = Platform.select({
  ios: fontFamily.monoIos,
  android: fontFamily.monoAndroid,
  default: fontFamily.mono,
});
/**
 * Spread onto a Text that shows code. On web it adds `data-mono`, which keeps the global Poppins
 * rule (src/font-files.ts) off that element so it stays in the monospace font.
 */
export const monoProps = (Platform.OS === "web" ? { dataSet: { mono: "1" } } : {}) as object;
/** True on a wide web window with a pointer. Touch layouts keep large targets; desktop gets denser rows. */
export function useDense(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === "web" && width >= 900;
}
/**
 * True on a wide window that is not a touch screen. A box there can have small text; on a phone or
 * a tablet, text under 16 px makes the browser zoom in when the box is tapped.
 */
export function useFineInput(): boolean {
  const { width } = useWindowDimensions();
  if (Platform.OS !== "web" || width < 900 || typeof window === "undefined") return false;
  return !window.matchMedia?.("(pointer: coarse)").matches;
}
/** react-native-web also passes hover and focus state to Pressable style callbacks; React Native's types only declare `pressed`. */
export type WebPressState = { pressed: boolean; hovered?: boolean; focused?: boolean };
export const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  text: { color: colors.text, ...type.body },
  muted: { color: colors.muted, ...type.ui },
  small: { color: colors.muted, ...type.caption },
  label: { color: colors.muted, ...type.label },
  title: { color: colors.text, ...type.title },
  heading: { color: colors.text, ...type.heading },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: sp.lg,
  },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: sp.xl },
  input: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.text,
    fontSize: fontSize.input,
    backgroundColor: colors.surface,
    minHeight: 40,
  },
  field: { gap: sp.sm, marginBottom: sp.xl },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: sp.sm,
    paddingHorizontal: 14,
    minHeight: 40,
    paddingVertical: 8,
    borderRadius: radius.md,
  },
  primary: { backgroundColor: colors.action },
  secondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  buttonText: { fontSize: fontSize.body, fontWeight: "600" },
  centred: { alignItems: "center", justifyContent: "center" },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    alignSelf: "flex-start",
    backgroundColor: colors.surfaceMuted,
  },
  chipText: { fontSize: fontSize.caption, fontWeight: "600", color: colors.muted },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.primarySoft,
  },
  error: {
    padding: sp.lg,
    borderRadius: radius.md,
    backgroundColor: colors.dangerBg,
    marginVertical: 10,
    gap: 4,
  },
  modalShade: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: "center",
    alignItems: "center",
    padding: sp.xl,
  },
  sheet: {
    ...glassSurface("sheet"),
    borderRadius: radius.lg,
    width: "100%",
    maxWidth: 790,
    maxHeight: "94%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.line,
  },
});
export function Button({
  children,
  onPress,
  icon: Icon,
  primary,
  disabled,
  busy,
  small,
  danger,
  style,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel?: string;
  /** A Lucide icon, or any mark that is drawn at `size` (one with colours of its own ignores `color`). */
  icon?: ComponentType<{ size?: number; color?: string }>;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  danger?: boolean;
  style?: ViewStyle;
}) {
  const color = danger ? colors.danger : primary ? colors.onAction : colors.text;
  const dense = useDense();
  const covered = !!busy && !Icon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled || busy}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      onPress={onPress}
      // A small button is under the size of a thumb: the touch reaches a little beyond it.
      hitSlop={small && !dense ? { top: 4, bottom: 4, left: 5, right: 5 } : undefined}
      style={({ pressed, hovered }: WebPressState) => [
        s.button,
        primary ? s.primary : s.secondary,
        (pressed || hovered) && {
          backgroundColor: primary ? colors.actionPressed : colors.surfaceHover,
        },
        dense && { minHeight: 34, paddingVertical: 6 },
        small && {
          minHeight: dense ? 28 : 36,
          paddingVertical: dense ? 4 : 6,
          paddingHorizontal: dense ? 10 : 12,
        },
        (disabled || busy) && { opacity: 0.5 },
        style,
      ]}
    >
      {Icon ? (
        <IconSlot size={15}>
          {busy ? (
            <ActivityIndicator
              color={color}
              size="small"
              style={{ transform: [{ scale: 0.75 }] }}
            />
          ) : (
            <Icon size={15} color={color} />
          )}
        </IconSlot>
      ) : null}
      <Text style={[s.buttonText, { color }, covered && { opacity: 0 }]}>{children}</Text>
      {covered && (
        // A button with no icon has no room for a spinner, and one added in front of the label
        // would make the button wider and move the label. The spinner goes over the label instead.
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, s.centred]}>
          <ActivityIndicator color={color} size="small" />
        </View>
      )}
    </Pressable>
  );
}
/**
 * The name of an icon-only button, shown under it once a pointer has rested on it for a moment.
 * A touch has no hover and a screen reader has the label, so this is only for the pointer. Spread
 * `props` on the Pressable and render `tip` inside it. `align` is which edge of the button the
 * name lines up with, so a button at the edge of its panel has its name run inward, not off it.
 * On a touch screen a tap passes for a hover and the name would stay on, so there it is not shown.
 */
export function useHoverTip(label: string, align: "start" | "center" | "end" = "end") {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hide = () => {
    clearTimeout(timer.current);
    setShown(false);
  };
  const props = {
    onHoverIn: () => {
      if (typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(true), 450);
    },
    onHoverOut: hide,
    // Pressing it is an answer to the question.
    onPressIn: hide,
  };
  const tip = shown ? (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: "100%",
        marginTop: 6,
        // Room for a name wider than the button, which runs one way from its edge.
        left: align === "end" ? -180 : align === "start" ? 0 : -90,
        right: align === "start" ? -180 : align === "end" ? 0 : -90,
        alignItems: align === "end" ? "flex-end" : align === "start" ? "flex-start" : "center",
        zIndex: 20,
      }}
    >
      <View
        style={{
          backgroundColor: colors.inverse,
          borderRadius: radius.sm,
          paddingHorizontal: 8,
          paddingVertical: 4,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            color: colors.onInverse,
            fontSize: fontSize.caption,
            lineHeight: 16,
            fontWeight: "500",
          }}
        >
          {label}
        </Text>
      </View>
    </View>
  ) : null;
  return { props, tip };
}
export function IconButton({
  icon: Icon,
  label,
  onPress,
  tipAlign,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  /** Which edge of the button its name (shown on hover) lines up with; the right one unless it says. */
  tipAlign?: "start" | "center" | "end";
}) {
  const { props, tip } = useHoverTip(label, tipAlign);
  // A pointer is exact, so on a wide window the button is the size of its icon plus a little.
  const dense = useDense();
  const size = dense ? 32 : 44;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...props}
      style={({ pressed, hovered }: WebPressState) => [
        {
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: size / 2,
          backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
        },
      ]}
    >
      <Icon size={dense ? 18 : 20} strokeWidth={1.8} color={colors.text} />
      {tip}
    </Pressable>
  );
}
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}
/**
 * Fill and border of a card that can be selected. Idle, it has a 1px hairline (`idleBorder`). The
 * selected card gets a 2px teal border; the idle card's 1px margin makes up the difference, so
 * selecting never moves the content.
 */
export function selectedCard(
  selected: boolean,
  fill: string = colors.surface,
  idleBorder: string = "transparent",
): ViewStyle {
  if (!selected) {
    return { borderWidth: 1, borderColor: idleBorder, margin: 1, backgroundColor: fill };
  }
  return { borderWidth: 2, borderColor: colors.selectedLine, backgroundColor: colors.selected };
}
/**
 * "Create something new": a dashed amber outline round an icon and a label, like the new-note card
 * in the web app. Amber marks creation across the app. The label is dark amber so it stays readable.
 */
export function CreateTile({
  icon: Icon,
  label,
  onPress,
  accessibilityLabel,
  style,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed, hovered }: WebPressState) => [
        s.row,
        {
          gap: 12,
          minHeight: 56,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderWidth: 2,
          borderStyle: "dashed",
          borderColor: colors.accent,
          borderRadius: radius.xl,
          backgroundColor: pressed || hovered ? colors.accentSoft : colors.surface,
        },
        style,
      ]}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          borderWidth: 1.5,
          borderStyle: "dashed",
          borderColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={18} color={colors.accentText} />
      </View>
      <Text style={[s.text, { flex: 1, fontWeight: "500", color: colors.accentText }]}>
        {label}
      </Text>
      <Plus size={18} color={colors.accentText} />
    </Pressable>
  );
}
export function Chip({
  children,
  tint,
  color,
}: {
  children: ReactNode;
  tint?: string;
  color?: string;
}) {
  return (
    <View style={[s.chip, tint ? { backgroundColor: tint } : null]}>
      <Text style={[s.chipText, color ? { color } : null]}>{children}</Text>
    </View>
  );
}
export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  dot?: string;
  /** For a screen reader, when the label alone is not enough. */
  accessibilityLabel?: string;
  onLongPress?: () => void;
}

interface SegmentedProps<T extends string> {
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
  /** Side padding of each tab, when the room is short. */
  pad?: number;
}

/**
 * The row of tabs itself, for putting beside something else. The tabs sit on one slab; the chosen
 * one pulls out of it, and the one you leave flows back in.
 */
export function SegmentedRow<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  pad,
}: SegmentedProps<T>) {
  const dense = useDense();
  const height = dense ? 28 : 34;
  // The tabs are as wide as their labels, so each reports its width, and the slab behind them is
  // cut to fit. (Widths, not positions: a layout event comes only when a size changes.) Until they
  // have all reported, the slab is a plain pill.
  const [widths, setWidths] = useState<Record<string, number>>({});
  const measured = options.every((option) => widths[option.id] !== undefined);
  const bounds = [0];
  if (measured)
    for (const option of options) bounds.push(bounds[bounds.length - 1] + widths[option.id]);
  const active = options.findIndex((option) => option.id === value);
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={[
        {
          flexDirection: "row",
          height,
          opacity: disabled ? 0.6 : 1,
        },
        !measured && { borderRadius: radius.pill, backgroundColor: colors.tile },
      ]}
    >
      {measured && (
        <LiquidTrack
          ids={options.map((option) => option.id)}
          active={active}
          bounds={bounds}
          height={height}
          gap={dense ? 6 : 8}
          fill={colors.selected}
          line={colors.selectedLine}
        />
      )}
      {options.map((option, index) => {
        const selected = option.id === value;
        // The chosen tab's outline is held back from the tab beside it, so at either end of the row
        // it is narrower on that side; the label moves half that to stay in the middle of it.
        const seamGap = dense ? 6 : 8;
        const shift =
          !selected || options.length < 2
            ? 0
            : index === options.length - 1
              ? seamGap / 4
              : index === 0
                ? -seamGap / 4
                : 0;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityLabel={option.accessibilityLabel}
            accessibilityState={{ selected, disabled: !!disabled }}
            aria-selected={selected}
            disabled={disabled}
            onPress={() => onChange(option.id)}
            onLongPress={option.onLongPress}
            delayLongPress={500}
            onLayout={(event) => {
              const { width } = event.nativeEvent.layout;
              setWidths((now) => (now[option.id] === width ? now : { ...now, [option.id]: width }));
            }}
            style={({ pressed, hovered }: WebPressState) => ({
              flexShrink: 0,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              height,
              paddingHorizontal: pad ?? (dense ? 14 : 16),
              borderRadius: radius.pill,
              backgroundColor:
                !selected && (hovered || pressed) ? colors.surfaceHover : "transparent",
            })}
          >
            {!!option.dot && (
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: option.dot }} />
            )}
            <SteadyLabel
              bold={selected}
              shift={shift}
              style={{
                fontSize: fontSize.ui,
                color: selected ? colors.text : colors.muted,
              }}
            >
              {option.label}
            </SteadyLabel>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A label that goes from medium to semibold without its box changing size. Semibold is wider, so a
 * tab that turns bold when chosen would push the tabs beside it along. The semibold text sits in
 * the box, unseen and with no height, to say how wide it is; the visible one is drawn over it.
 */
function SteadyLabel({
  bold,
  shift = 0,
  style,
  children,
}: {
  bold: boolean;
  shift?: number;
  style: TextStyle;
  children: string;
}) {
  return (
    <View style={shift ? { transform: [{ translateX: shift }] } : undefined}>
      <Text
        aria-hidden
        accessible={false}
        numberOfLines={1}
        style={[style, { fontWeight: "600", height: 0, opacity: 0 }]}
      >
        {children}
      </Text>
      <Text numberOfLines={1} style={[style, { fontWeight: bold ? "600" : "500" }]}>
        {children}
      </Text>
    </View>
  );
}

/** How little room each tab keeps at its sides, step by step, before the row has to scroll. */
const TIGHT_PADS = [10, 7];

/** One choice out of a few, shown together (view switchers, filters, priority). */
export function Segmented<T extends string>(props: SegmentedProps<T>) {
  // On a narrow screen the tabs first draw closer together, so that they fit rather than slide
  // sideways with the chosen one cut off at the edge. A new window width starts over.
  const { width: windowWidth } = useWindowDimensions();
  const [tighten, setTighten] = useState(0);
  const [room, setRoom] = useState({ shown: 0, content: 0 });
  useEffect(() => {
    void windowWidth;
    setTighten(0);
    setRoom((now) => ({ ...now, content: 0 }));
  }, [windowWidth]);
  useEffect(() => {
    if (room.content > room.shown + 0.5 && tighten < TIGHT_PADS.length) {
      // What was measured was at the old padding; wait for the row to say how wide it is now.
      setRoom((now) => ({ ...now, content: 0 }));
      setTighten((n) => n + 1);
    }
  }, [room, tighten]);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, maxWidth: "100%", alignSelf: "flex-start" }}
      contentContainerStyle={{ flexGrow: 0 }}
      onLayout={(event) => {
        const shown = event.nativeEvent.layout.width;
        setRoom((now) => ({ ...now, shown }));
      }}
      onContentSizeChange={(content) => setRoom((now) => ({ ...now, content }))}
    >
      {/* Fresh for each padding, so the outline is drawn from widths measured at that padding. */}
      <SegmentedRow
        key={tighten}
        {...props}
        pad={tighten > 0 ? TIGHT_PADS[tighten - 1] : props.pad}
      />
    </ScrollView>
  );
}
/** The browser's own focus ring is replaced by the teal border and halo drawn on focus. */
const noOutline = (Platform.OS === "web" ? { outlineStyle: "none" } : undefined) as
  | TextStyle
  | undefined;
export function Field({
  label,
  compact,
  ...props
}: TextInputProps & { label: string; compact?: boolean }) {
  const [focused, setFocused] = useState(false);
  const fine = useFineInput();
  return (
    <View style={[s.field, compact && { marginBottom: 0 }]}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        accessibilityLabel={label}
        {...props}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        style={[
          s.input,
          fine && { fontSize: fontSize.body, minHeight: 34, paddingVertical: 6 },
          noOutline,
          focused && { borderColor: colors.primary, boxShadow: shadow.focus },
          props.multiline && { minHeight: 120, textAlignVertical: "top" },
          props.style,
        ]}
      />
    </View>
  );
}
/** Inline search box. Its border carries the focus state, so the browser's own ring inside it is switched off. */
export function SearchField({
  label,
  placeholder,
  value,
  onChangeText,
  style,
  slim,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  style?: ViewStyle;
  /** A thinner box for a list's head, as in a sidebar. */
  slim?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const fine = useFineInput();
  return (
    <View
      style={[
        s.row,
        {
          gap: 9,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: focused ? colors.primary : colors.lineStrong,
          borderRadius: slim ? radius.pill : radius.md,
          paddingHorizontal: slim ? 10 : 14,
          ...(focused ? { boxShadow: shadow.focus } : null),
        },
        style,
      ]}
    >
      <View style={{ flexShrink: 0 }}>
        <Search size={16} color={colors.muted} />
      </View>
      <TextInput
        accessibilityLabel={label}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        returnKeyType="search"
        autoCorrect={false}
        style={[
          {
            flex: 1,
            minWidth: 0,
            paddingVertical: slim ? (fine ? 4 : 6) : fine ? 6 : 10,
            fontSize: fine ? fontSize.ui : fontSize.input,
            color: colors.text,
          },
          noOutline,
        ]}
      />
      {!!value && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={12}
          onPress={() => onChangeText("")}
        >
          <X size={16} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}
export function Empty({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <View style={{ alignItems: "center", padding: 32, gap: 14 }}>
      <View style={[s.iconBox, { width: 56, height: 56, borderRadius: radius.lg }]}>
        <Icon size={24} color={colors.primary} />
      </View>
      <Text style={s.heading}>{title}</Text>
      <Text style={[s.muted, { textAlign: "center", maxWidth: 360 }]}>{detail}</Text>
      {children}
    </View>
  );
}
export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <View accessibilityRole="alert" style={s.error}>
      <Text style={[s.text, { color: colors.danger }]}>{error}</Text>
    </View>
  ) : null;
}
/**
 * A box for whatever stands where an icon would: the icon, a tick, or a spinner while something
 * happens. It is the same size with any of them in it, so swapping one for another moves nothing
 * beside it. (A bare spinner is 20 points; an icon is 14 to 19.)
 */
export function IconSlot({ size = 20, children }: { size?: number; children?: ReactNode }) {
  return <View style={[{ width: size, height: size }, s.centred]}>{children}</View>;
}
/** A small spinner in an `IconSlot`, for the front of a row. */
export function Spinner({ color = colors.primary }: { color?: string }) {
  return (
    <IconSlot>
      <ActivityIndicator size="small" color={color} />
    </IconSlot>
  );
}
/**
 * What stands where a list or a page will be while it loads: a spinner (and what is being waited
 * for) in a box about as tall as the content usually is, so the room is mostly there already when
 * the content arrives. Only what is below it has to move.
 */
export function Pending({ label, height = 120 }: { label?: string; height?: number }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[{ minHeight: height, flexDirection: "row", gap: 10 }, s.centred]}
    >
      <ActivityIndicator color={colors.primary} />
      {!!label && <Text style={s.muted}>{label}</Text>}
    </View>
  );
}
export function Sheet({
  title,
  subtitle,
  children,
  onClose,
  wide,
  narrow,
  tall,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /** For a sheet whose content arrives after it opens: on a phone it opens at its full height, so the title does not move when the content comes. */
  tall?: boolean;
  /** For a short form, which does not need the usual width. */
  narrow?: boolean;
}) {
  useBackToClose(onClose);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = width < 600;
  // The sheet's top edge is where the eye is. A sheet centred on the screen, or standing on the
  // bottom edge, has its top edge move whenever its content changes height (a list arriving, a
  // spinner going), and the title with it. So on a wide screen the sheet hangs from a fixed line
  // and only its bottom edge moves; on a phone it is fixed in height when its content is fetched.
  const top = Math.min(72, Math.max(sp.xl, Math.round(height * 0.06)));
  return (
    <Modal transparent animationType={compact ? "slide" : "fade"} visible onRequestClose={onClose}>
      <View
        style={[
          s.modalShade,
          compact
            ? { padding: 0, justifyContent: "flex-end" }
            : { justifyContent: "flex-start", paddingTop: top },
        ]}
      >
        <View
          accessibilityViewIsModal
          style={[
            s.sheet,
            wide && { maxWidth: 1050 },
            narrow && { maxWidth: 520 },
            !compact && { maxHeight: "100%" },
            compact && {
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              paddingBottom: Math.max(insets.bottom, 12),
              maxHeight: "94%",
            },
            compact && tall && { height: "94%" },
          ]}
        >
          {compact && (
            <View
              style={{
                alignSelf: "center",
                width: 34,
                height: 4,
                borderRadius: radius.sm,
                backgroundColor: colors.lineStrong,
                marginTop: 10,
              }}
            />
          )}
          <View
            style={[
              s.between,
              { padding: compact ? 16 : 20, borderBottomWidth: 1, borderBottomColor: colors.line },
            ]}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.title}>{title}</Text>
              {!!subtitle && <Text style={s.muted}>{subtitle}</Text>}
            </View>
            <IconButton icon={X} label="Close details" onPress={onClose} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: compact ? 16 : 20 }}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
export function CheckRow({
  label,
  checked,
  onPress,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[s.row, { gap: 12, paddingVertical: 12 }]}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: radius.sm,
          borderWidth: 1,
          borderColor: checked ? colors.primary : colors.lineStrong,
          backgroundColor: checked ? colors.primary : colors.surface,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Check size={13} color={colors.onPrimary} />}
      </View>
      <Text style={[s.text, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}
export function SectionHeading({
  title,
  action,
  onPress,
}: {
  title: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={[s.between, { marginBottom: 8 }]}>
      <Text style={s.heading}>{title}</Text>
      {action && onPress && (
        <Pressable accessibilityRole="button" onPress={onPress} style={[s.row, { gap: 5 }]}>
          <Text style={[s.small, { color: colors.text }]}>{action}</Text>
          <ArrowUpRight size={13} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}
export function LinkRow({
  title,
  detail,
  onPress,
  icon: Icon,
  tint,
}: {
  title: string;
  detail?: string;
  onPress: () => void;
  icon: LucideIcon;
  tint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed, hovered }: WebPressState) => [
        s.row,
        { paddingVertical: 12, gap: 14, borderRadius: radius.lg },
        (pressed || hovered) && { backgroundColor: colors.surfaceMuted },
      ]}
    >
      <View style={[s.iconBox, { backgroundColor: tint || colors.primarySoft }]}>
        <Icon size={19} color={tint ? colors.text : colors.primary} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.text, { fontWeight: "500" }]}>{title}</Text>
        {!!detail && <Text style={s.small}>{detail}</Text>}
      </View>
      <ChevronRight size={15} color={colors.muted} />
    </Pressable>
  );
}
/** A dot with a soft ring round it: the marker in front of a status heading. */
export function HaloDot({ color, halo }: { color: string; halo: string }) {
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: halo,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
    </View>
  );
}
/** Whether the still bee has loaded once, so a bee that appears later is there on its first frame. */
let stillBeeLoaded = false;
/** Hive's bee, shared by every assistant surface. */
export function Mascot({
  size = 42,
  variant = "sky",
  art,
  ready = true,
}: {
  size?: number;
  variant?: "sky" | "sand" | "lilac";
  /** What to draw in place of the still bee, in the same box and over the same disc (the moving bee). */
  art?: ReactNode;
  /** With `art`: whether it has loaded. Until it has, the still bee holds its place. */
  ready?: boolean;
}) {
  const palette = mascotTints[variant];
  const [pictured, setPictured] = useState(stillBeeLoaded);
  // The moving bee takes over from the still one, which is the same size in the same place, so the
  // bee is there the whole time and only starts to move. The disc waits for a bee to be in it,
  // since a disc with no bee reads as a flash.
  const moving = !!art && ready;
  const shown = moving || pictured;
  return (
    <View accessibilityLabel="Hive bee" style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute",
          top: size * 0.2,
          left: size * 0.14,
          width: size * 0.72,
          height: size * 0.72,
          borderRadius: size,
          backgroundColor: palette,
          opacity: shown ? 1 : 0,
        }}
      />
      <Image
        source={require("../assets/bee.png")}
        resizeMode="contain"
        style={{ width: size, height: size, opacity: !moving && pictured ? 1 : 0 }}
        accessible={false}
        onLoad={() => {
          stillBeeLoaded = true;
          setPictured(true);
        }}
        onError={() => setPictured(true)}
      />
      {art}
    </View>
  );
}
/** The size of the bee on the screens that stand alone (sign in, set up, loading), moving or not. */
export const pageBee = 96;
/** True while an input method is mid-composition. Enter confirms the candidate then and must not submit. */
export function composingText(event: object): boolean {
  const { isComposing, keyCode } = event as { isComposing?: boolean; keyCode?: number };
  return !!isComposing || keyCode === 229;
}

const typingDots = ["first", "second", "third"].map((id, index) => ({
  id,
  delay: index * 150,
  tail: (2 - index) * 150,
}));
/** Three pulsing dots while the agent works. Static when the system asks for reduced motion. */
export function TypingDots() {
  const values = useRef(typingDots.map(() => new Animated.Value(0.35))).current;
  const [still, setStill] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((reduce) => {
        if (active) setStill(reduce);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (still) return;
    const useNativeDriver = Platform.OS !== "web";
    const loops = values.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(typingDots[index].delay),
          Animated.timing(value, { toValue: 1, duration: 320, useNativeDriver }),
          Animated.timing(value, { toValue: 0.35, duration: 320, useNativeDriver }),
          Animated.delay(typingDots[index].tail),
        ]),
      ),
    );
    for (const loop of loops) loop.start();
    return () => {
      for (const loop of loops) loop.stop();
    };
  }, [still, values]);
  return (
    <>
      {typingDots.map((dot, index) => (
        <Animated.View
          key={dot.id}
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: colors.muted,
            opacity: still ? 0.6 : values[index],
            transform: [
              {
                scale: still
                  ? 1
                  : values[index].interpolate({ inputRange: [0.35, 1], outputRange: [0.85, 1.15] }),
              },
            ],
          }}
        />
      ))}
    </>
  );
}

export function dateLabel(value: string, options?: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", options || { month: "short", day: "numeric" });
}
export function timeLabel(value: string, timeZone?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}
export function relativeDate(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  return diff < 60_000
    ? "Just now"
    : diff < 3600_000
      ? `${Math.floor(diff / 60_000)}m ago`
      : diff < 86400_000
        ? `${Math.floor(diff / 3600_000)}h ago`
        : dateLabel(value);
}

export function resultSummary(value: string) {
  return /^Saved to (?:sample|local) sent mail(?: · .+)?$/.test(value)
    ? "Reply saved in your local Sent mail."
    : value;
}
