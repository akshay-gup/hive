import {
  ArrowUpRight,
  Check,
  ChevronRight,
  type LucideIcon,
  Plus,
  Search,
  X,
} from "lucide-react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { HazeImage } from "./HazeImage";
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

const onWeb = Platform.OS === "web";
/**
 * The native glass look is opt-in at build time (EXPO_PUBLIC_LIQUID_GLASS=1) and only on iOS: the
 * haze as React Native's own gradient style, and Apple's Liquid Glass on the floating bars. The web
 * has neither (it has `backdropFilter`), and Android is left as it is.
 */
const nativeGlass = Platform.OS === "ios" && process.env.EXPO_PUBLIC_LIQUID_GLASS === "1";
/**
 * Apple's Liquid Glass (`expo-glass-effect`), when the build opts in and the phone is on iOS 26 or
 * later. It is required here, not imported at the top: a native module missing from a binary
 * throws as soon as it loads, and a build that has not opted in must not even look for it.
 */
const liquidGlass: typeof import("expo-glass-effect") | null = (() => {
  if (!nativeGlass) return null;
  try {
    const glassEffect = require("expo-glass-effect") as typeof import("expo-glass-effect");
    return glassEffect.isLiquidGlassAvailable() ? glassEffect : null;
  } catch {
    return null;
  }
})();

export type GlassKind = "panel" | "bar" | "raised" | "sheet";
const glassShadow: Record<GlassKind, string> = {
  panel: shadow.panel,
  bar: shadow.float,
  raised: shadow.float,
  sheet: shadow.popover,
};
/**
 * The fill and shadow of a glass surface. On the web the fill is translucent, and a sheet also
 * blurs the page behind it. A panel has only the haze behind it, which is dithered (`HazeImage`),
 * and a blur would average that back into steps, so it does not blur. Native has no blur here, so
 * it gets a more opaque fill and keeps the shadow. Bars and the composer sit on a panel or the
 * haze, so a blur would only cost them a layer.
 */
export function glassSurface(kind: GlassKind): ViewStyle {
  return {
    backgroundColor: onWeb ? glass[kind] : glass[`${kind}Solid`],
    boxShadow: glassShadow[kind],
    // CSS that React Native's types do not list; react-native-web passes it through (and adds the
    // -webkit- prefix for Safari).
    ...(onWeb && kind === "sheet"
      ? ({ backdropFilter: glass.blur } as unknown as ViewStyle)
      : null),
  };
}
/** A floating panel: the sidebar, a channel, a thread, the main area. */
export const panelStyle: ViewStyle = {
  ...glassSurface("panel"),
  borderRadius: radius.panel,
  overflow: "hidden",
};
/**
 * A floating bar or pill: the phone's header and tab bar, and the composer. On iOS 26 or later, in
 * a build that opts in, it is Apple's Liquid Glass; everywhere else it is the fill and shadow from
 * `glassSurface`. `glass={false}` draws neither, for a bar that only floats on some layouts. The
 * shape (`borderRadius`) and the border come from `style`, as for a View.
 */
export function GlassBar({
  kind,
  glass: floating = true,
  style,
  children,
  ...rest
}: ViewProps & { kind: "bar" | "raised"; glass?: boolean }) {
  if (!floating)
    return (
      <View style={style} {...rest}>
        {children}
      </View>
    );
  if (liquidGlass) {
    const { GlassView } = liquidGlass;
    return (
      <GlassView glassEffectStyle="regular" style={style} {...rest}>
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[glassSurface(kind), style]} {...rest}>
      {children}
    </View>
  );
}
/**
 * The haze behind the panels. The web shows it as a picture with its steps dithered away
 * (`HazeImage`), over the same pools as CSS gradients for the moment before that is ready. On iOS,
 * in a build that opts in, it is the gradients through React Native's own style; otherwise native
 * shows the flat base colour of the screen it sits on. Put it first inside a screen-sized view.
 */
export function Backdrop() {
  if (!onWeb) {
    if (!nativeGlass) return null;
    return (
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: haze.base, experimental_backgroundImage: haze.layers },
        ]}
      />
    );
  }
  return (
    <View
      pointerEvents="none"
      aria-hidden
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: haze.base },
        // The `background` shorthand: the gradients and the base colour in one.
        { background: haze.css } as unknown as ViewStyle,
      ]}
    >
      <HazeImage />
    </View>
  );
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
    boxShadow: shadow.card,
  },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: sp.xl },
  input: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.text,
    fontSize: fontSize.heading,
    backgroundColor: colors.surface,
    minHeight: 44,
  },
  field: { gap: sp.sm, marginBottom: sp.xl },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: sp.sm,
    paddingHorizontal: 16,
    minHeight: 44,
    paddingVertical: 10,
    borderRadius: radius.md,
  },
  primary: { backgroundColor: colors.primary },
  secondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    boxShadow: shadow.card,
  },
  buttonText: { fontSize: fontSize.body, fontWeight: "600" },
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
  icon?: LucideIcon;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  danger?: boolean;
  style?: ViewStyle;
}) {
  const color = danger ? colors.danger : primary ? colors.onPrimary : colors.text;
  const dense = useDense();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled || busy}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      onPress={onPress}
      style={({ pressed, hovered }: WebPressState) => [
        s.button,
        primary ? s.primary : s.secondary,
        (pressed || hovered) && {
          backgroundColor: primary ? colors.primaryPressed : colors.surfaceHover,
        },
        dense && { minHeight: 40, paddingVertical: 8 },
        small && {
          minHeight: dense ? 34 : 40,
          paddingVertical: dense ? 6 : 8,
          paddingHorizontal: 14,
        },
        (disabled || busy) && { opacity: 0.5 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} size="small" />
      ) : Icon ? (
        <Icon size={15} color={color} />
      ) : null}
      <Text style={[s.buttonText, { color }]}>{children}</Text>
    </Pressable>
  );
}
export function IconButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed, hovered }: WebPressState) => [
        {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 22,
          backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
        },
      ]}
    >
      <Icon size={20} strokeWidth={1.8} color={colors.text} />
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
        hovered && { boxShadow: shadow.card },
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
}: SegmentedProps<T>) {
  const dense = useDense();
  const height = dense ? 32 : 38;
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
      {options.map((option) => {
        const selected = option.id === value;
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
              paddingHorizontal: dense ? 14 : 16,
              borderRadius: radius.pill,
              backgroundColor:
                !selected && (hovered || pressed) ? colors.surfaceHover : "transparent",
            })}
          >
            {!!option.dot && (
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: option.dot }} />
            )}
            <Text
              numberOfLines={1}
              style={{
                fontSize: fontSize.ui,
                fontWeight: selected ? "600" : "500",
                color: selected ? colors.text : colors.muted,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One choice out of a few, shown together (view switchers, filters, priority). */
export function Segmented<T extends string>(props: SegmentedProps<T>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, maxWidth: "100%", alignSelf: "flex-start" }}
      contentContainerStyle={{ flexGrow: 0 }}
    >
      <SegmentedRow {...props} />
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
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  style?: ViewStyle;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        s.row,
        {
          gap: 9,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: focused ? colors.primary : colors.lineStrong,
          borderRadius: radius.md,
          paddingHorizontal: 14,
          ...(focused ? { boxShadow: shadow.focus } : null),
        },
        style,
      ]}
    >
      <Search size={16} color={colors.muted} />
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
          { flex: 1, paddingVertical: 12, fontSize: fontSize.body, color: colors.text },
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
export function Sheet({
  title,
  subtitle,
  children,
  onClose,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = width < 600;
  return (
    <Modal transparent animationType={compact ? "slide" : "fade"} visible onRequestClose={onClose}>
      <View style={[s.modalShade, compact && { padding: 0, justifyContent: "flex-end" }]}>
        <View
          accessibilityViewIsModal
          style={[
            s.sheet,
            wide && { maxWidth: 1050 },
            compact && {
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              paddingBottom: Math.max(insets.bottom, 12),
              maxHeight: "94%",
            },
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
    <View style={[s.between, { marginBottom: 16 }]}>
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
/** Hive's bee, shared by every assistant surface. */
export function Mascot({
  size = 42,
  variant = "sky",
  art,
}: {
  size?: number;
  variant?: "sky" | "sand" | "lilac";
  /** What to draw in place of the still bee, in the same box and over the same disc (the moving bee). */
  art?: ReactNode;
}) {
  const palette = mascotTints[variant];
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
        }}
      />
      {art ?? (
        <Image
          source={require("../assets/bee.png")}
          resizeMode="contain"
          style={{ width: size, height: size }}
          accessible={false}
        />
      )}
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
