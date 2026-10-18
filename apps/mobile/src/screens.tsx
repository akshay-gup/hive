import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  ArrowDownToLine,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Globe2,
  HardDrive,
  Inbox,
  Link2,
  Mail,
  Plus,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  Image,
  Linking,
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type {
  Artifact,
  BrowserSession,
  CalendarEvent,
  EmailDraft,
} from "../../../packages/domain/src";
import { AnimatedBee } from "./animated-bee";
import { localDateTime, zonedInstant } from "./date-time";
import {
  avatarTints,
  Button,
  brand,
  Card,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  eventColors,
  fontSize,
  IconButton,
  LinkRow,
  Pending,
  radius,
  relativeDate,
  resultSummary,
  SearchField,
  SectionHeading,
  Sheet,
  s,
  shadow,
  timeLabel,
  type WebPressState,
} from "./ui";
import { useWorkspace } from "./workspace";

function todayDate() {
  return localDateTime(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone)
    .date;
}
function eventDate(event: CalendarEvent) {
  return event.allDay ? event.start : localDateTime(event.start, event.timeZone).date;
}
export function TodayScreen() {
  const { workspace: w, navigate, open, ask } = useWorkspace();
  const wide = useWindowDimensions().width > 1180;
  const pending = w.actions.filter((a) => a.status === "awaiting_review");
  const unread = w.mail.filter((m) => m.unread);
  const today = todayDate();
  const events = w.events
    .filter((e) => eventDate(e) === today)
    .sort((a, b) => a.start.localeCompare(b.start));
  return (
    <View style={{ gap: 24 }}>
      <View
        style={[
          {
            backgroundColor: colors.primarySoft,
            borderRadius: radius.xxl,
            padding: 32,
            minHeight: 228,
            overflow: "hidden",
          },
          s.row,
        ]}
      >
        <View style={{ flex: 1, gap: 15, zIndex: 1 }}>
          <View style={[s.row, { gap: 7 }]}>
            <Sparkles size={13} color={colors.primary} />
            <Text style={[s.label, { color: colors.primaryText }]}>
              A little clarity, every day
            </Text>
          </View>
          <Text
            style={{
              fontSize: wide ? 39 : 29,
              lineHeight: wide ? 45 : 36,
              letterSpacing: -1.7,
              fontWeight: "500",
              color: colors.text,
            }}
          >
            Your day, with a little{"\n"}more room to breathe.
          </Text>
          <Text style={[s.muted, { maxWidth: 420, color: colors.muted }]}>
            {events.length ? `${events.length} things on your calendar` : "Your calendar has room"}
            {unread.length ? `, ${unread.length} unread emails` : ""}.{"\n"}Let’s make space for
            what matters.
          </Text>
          <Button
            onPress={() => ask("Help me plan my day")}
            icon={Sparkles}
            primary
            style={{ alignSelf: "flex-start", marginTop: 5 }}
          >
            Plan my day
          </Button>
        </View>
        {wide && (
          <View style={{ width: 220, height: 210, alignItems: "center", justifyContent: "center" }}>
            <View
              style={{
                position: "absolute",
                width: 190,
                height: 190,
                borderRadius: 100,
                backgroundColor: colors.primarySoftStrong,
              }}
            />
            <View
              style={{
                position: "absolute",
                width: 145,
                height: 145,
                borderRadius: 80,
                borderWidth: 1,
                borderColor: colors.line,
              }}
            />
            <AnimatedBee loop={3} size={154} />
            <View
              style={[
                s.row,
                {
                  position: "absolute",
                  top: 17,
                  left: -19,
                  padding: 11,
                  gap: 7,
                  backgroundColor: colors.surface,
                  borderRadius: radius.lg,
                  transform: [{ rotate: "-7deg" }],
                },
              ]}
            >
              <Check size={14} color={colors.success} />
              <Text style={s.small}>A lighter day</Text>
            </View>
            <View
              style={[
                s.row,
                {
                  position: "absolute",
                  bottom: 18,
                  right: -8,
                  padding: 12,
                  gap: 8,
                  backgroundColor: colors.surface,
                  borderRadius: radius.lg,
                  transform: [{ rotate: "5deg" }],
                },
              ]}
            >
              <CalendarDays size={17} color={colors.primary} />
              <Text style={s.small}>Everything, together</Text>
            </View>
          </View>
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
        {[
          {
            label: "UNREAD EMAILS",
            value: unread.length,
            note: "A fresh look at your inbox",
            icon: Mail,
            section: "mail" as const,
            tint: colors.primarySoft,
          },
          {
            label: "ON THE CALENDAR",
            value: events.length,
            note: "Make room for your priorities",
            icon: CalendarDays,
            section: "calendar" as const,
            tint: colors.successBg,
          },
          {
            label: "WAITING FOR YOU",
            value: pending.length,
            note: "Your review keeps things moving",
            icon: ShieldCheck,
            section: "activity" as const,
            tint: colors.primarySoft,
          },
        ].map((item) => (
          <Pressable
            key={item.label}
            accessibilityRole="button"
            onPress={() => navigate(item.section)}
            style={{ flex: 1, minWidth: 180 }}
          >
            <Card style={{ padding: 20, minHeight: 148 }}>
              <View style={s.between}>
                <Text style={s.label}>{item.label}</Text>
                <View
                  style={[
                    s.iconBox,
                    { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: item.tint },
                  ]}
                >
                  <item.icon size={17} color={colors.text} />
                </View>
              </View>
              <Text
                style={{
                  fontSize: fontSize.display,
                  color: colors.text,
                  letterSpacing: -1,
                  marginTop: 8,
                }}
              >
                {String(item.value).padStart(2, "0")}
              </Text>
              <Text style={[s.small, { marginTop: 4 }]}>{item.note}</Text>
            </Card>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: wide ? "row" : "column", gap: 24 }}>
        <Card style={{ flex: 1 }}>
          <SectionHeading
            title="On your calendar"
            action="Full calendar"
            onPress={() => navigate("calendar")}
          />
          {events.length ? (
            events.slice(0, 3).map((e, i) => <AgendaRow key={e.id} event={e} index={i} />)
          ) : (
            <Empty
              icon={CalendarDays}
              title="Some breathing room"
              detail="No events scheduled today."
            />
          )}
          <Pressable
            onPress={() => open({ type: "event" })}
            style={[
              s.row,
              {
                gap: 8,
                paddingVertical: 12,
                marginTop: 9,
                borderTopWidth: 1,
                borderTopColor: colors.line,
              },
            ]}
          >
            <Plus size={16} color={colors.muted} />
            <Text style={[s.text, { fontSize: fontSize.ui }]}>Make time for something</Text>
          </Pressable>
        </Card>
        <Card style={{ flex: 1 }}>
          <SectionHeading
            title="From your inbox"
            action="Open mail"
            onPress={() => navigate("mail")}
          />
          {w.mail.length ? (
            w.mail.slice(0, 3).map((m, i) => (
              <Pressable
                key={m.id}
                onPress={() => open({ type: "mail", mail: m })}
                style={[
                  s.row,
                  {
                    gap: 12,
                    paddingVertical: 13,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: colors.line,
                  },
                ]}
              >
                <Avatar name={m.sender} index={i} />
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={s.between}>
                    <Text style={[s.text, { fontSize: fontSize.ui, fontWeight: "600" }]}>
                      {m.sender}
                    </Text>
                    <Text style={s.small}>{timeLabel(m.date)}</Text>
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[s.text, { fontSize: fontSize.ui, lineHeight: 20 }]}
                  >
                    {m.subject}
                  </Text>
                  <Text numberOfLines={1} style={[s.small, { fontSize: fontSize.caption }]}>
                    {m.body.replace(/\n/g, " ")}
                  </Text>
                </View>
                {m.unread && (
                  <View
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: radius.sm,
                      backgroundColor: colors.primary,
                    }}
                  />
                )}
              </Pressable>
            ))
          ) : (
            <Empty
              icon={Inbox}
              title="Inbox is quiet"
              detail="Connect Google to bring your messages here."
            />
          )}
        </Card>
      </View>
      <View style={{ flexDirection: wide ? "row" : "column", gap: 24 }}>
        <Card style={{ flex: 1, backgroundColor: colors.surfaceMuted }}>
          <SectionHeading title="A hand with the little things" />
          <Text style={[s.muted, { marginBottom: 15 }]}>
            Start with a thought. We’ll take it from there.
          </Text>
          {[
            "What needs my attention today?",
            "Help me catch up on my inbox",
            "Show my recent documents",
          ].map((prompt) => (
            <Pressable
              key={prompt}
              onPress={() => ask(prompt)}
              style={[
                s.between,
                { borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 13 },
              ]}
            >
              <Text style={[s.text, { fontSize: fontSize.caption }]}>{prompt}</Text>
              <ArrowUpRight size={15} color={colors.muted} />
            </Pressable>
          ))}
        </Card>
        <Card style={{ flex: 1 }}>
          <SectionHeading
            title={pending.length ? "Ready for your review" : "Recent activity"}
            action="View all"
            onPress={() => navigate("activity")}
          />
          {pending.length
            ? pending
                .slice(0, 3)
                .map((a) => (
                  <LinkRow
                    key={a.id}
                    title={a.title}
                    detail="Prepared · waiting for your approval"
                    onPress={() => open({ type: "review", action: a })}
                    icon={ShieldCheck}
                    tint={colors.primarySoft}
                  />
                ))
            : w.activity.slice(0, 3).map((a) => (
                <View key={a.id} style={[s.row, { gap: 13, paddingVertical: 12 }]}>
                  <View
                    style={[
                      s.iconBox,
                      { width: 32, height: 32, backgroundColor: colors.successBg },
                    ]}
                  >
                    <Check size={14} color={colors.text} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.text, { fontSize: fontSize.caption }]}>{a.title}</Text>
                    <Text style={s.small}>{relativeDate(a.date)}</Text>
                  </View>
                </View>
              ))}
          {!pending.length && !w.activity.length && (
            <Text style={s.muted}>
              Your workspace is ready. Things you do here will appear in your activity.
            </Text>
          )}
        </Card>
      </View>
    </View>
  );
}
function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  return (
    <View
      style={{
        width: 35,
        height: 35,
        borderRadius: radius.lg,
        backgroundColor: avatarTints[index % avatarTints.length],
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Text style={{ color: colors.text, fontSize: fontSize.micro, fontWeight: "500" }}>
        {name
          .split(" ")
          .map((p) => p[0])
          .slice(0, 2)
          .join("")}
      </Text>
    </View>
  );
}
export function AgendaRow({
  event: e,
  index = 0,
  neighbors,
}: {
  event: CalendarEvent;
  index?: number;
  neighbors?: CalendarEvent[];
}) {
  const { open } = useWorkspace();
  return (
    <Pressable
      onPress={() => open({ type: "event", event: e, neighbors })}
      style={[s.row, { gap: 16, paddingVertical: 14 }]}
    >
      <View style={{ width: 64 }}>
        <Text style={[s.text, { fontSize: fontSize.caption, fontWeight: "500" }]}>
          {e.allDay ? "All day" : timeLabel(e.start, e.timeZone)}
        </Text>
        {!e.allDay && <Text style={s.small}>{timeLabel(e.end, e.timeZone)}</Text>}
      </View>
      <View
        style={{
          width: 3,
          height: 44,
          borderRadius: radius.sm,
          backgroundColor: eventColors[index % eventColors.length],
        }}
      />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[s.text, { fontSize: fontSize.ui, fontWeight: "500" }]}>{e.title}</Text>
        <Text numberOfLines={1} style={s.small}>
          {e.location || (e.attendees.length ? `${e.attendees.length} attendees` : "Time for you")}
        </Text>
      </View>
      <ChevronRight size={14} color={colors.muted} />
    </Pressable>
  );
}
export function MailScreen() {
  const { workspace: w, api, open } = useWorkspace();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [drafts, setDrafts] = useState<(EmailDraft & { id: string; createdAt: string })[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void api
      .request<(EmailDraft & { id: string; createdAt: string })[]>("/api/drafts")
      .then(setDrafts)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, w]);
  const items = w.mail.filter(
    (m) =>
      (tab !== "unread" || m.unread) &&
      `${m.sender} ${m.subject} ${m.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredDrafts = drafts.filter((d) =>
    `${d.to.join(" ")} ${d.subject} ${d.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <View style={{ gap: 20 }}>
      <View style={[s.between, { gap: 12, flexWrap: "wrap" }]}>
        <SearchField
          label="Search mail"
          placeholder="Search your inbox"
          value={query}
          onChangeText={setQuery}
          style={{ flex: 1, minWidth: 200 }}
        />
        <Button onPress={() => open({ type: "email" })} primary icon={Plus}>
          Compose
        </Button>
      </View>
      <ErrorNotice error={error} />
      <Card>
        <View style={[s.row, { gap: 10, marginBottom: 15, flexWrap: "wrap" }]}>
          <Button small primary={tab === "all"} onPress={() => setTab("all")}>
            All messages
          </Button>
          <Button small primary={tab === "unread"} onPress={() => setTab("unread")}>
            Unread · {w.mail.filter((m) => m.unread).length}
          </Button>
          <Button small primary={tab === "drafts"} onPress={() => setTab("drafts")}>
            Drafts · {drafts.length}
          </Button>
        </View>
        {tab === "drafts" ? (
          filteredDrafts.length ? (
            filteredDrafts.map((d) => (
              <LinkRow
                key={d.id}
                icon={Mail}
                title={d.subject}
                detail={`To: ${d.to.join(", ")} · saved ${dateLabel(d.createdAt)}`}
                onPress={() => open({ type: "email", draft: d })}
              />
            ))
          ) : (
            <Empty
              icon={Mail}
              title="A fresh page"
              detail="Messages you save as drafts will be here when you’re ready."
            />
          )
        ) : items.length ? (
          items.map((m, i) => (
            <Pressable
              key={m.id}
              onPress={() => open({ type: "mail", mail: m })}
              style={[
                s.row,
                { gap: 16, paddingVertical: 18, borderTopWidth: 1, borderTopColor: colors.line },
              ]}
            >
              <Avatar name={m.sender} index={i} />
              <View style={{ flex: 1, gap: 6 }}>
                <View style={s.between}>
                  <Text style={[s.text, { fontWeight: m.unread ? "600" : "400" }]}>{m.sender}</Text>
                  <Text style={s.small}>{dateLabel(m.date)}</Text>
                </View>
                <Text style={[s.text, { fontWeight: "500", fontSize: fontSize.ui }]}>
                  {m.subject}
                </Text>
                <Text style={s.muted} numberOfLines={1}>
                  {m.body.replace(/\n/g, " ")}
                </Text>
                {!!m.attachments.length && (
                  <View style={[s.row, { gap: 4, marginTop: 2 }]}>
                    <FileText size={12} color={colors.muted} />
                    <Text style={s.small}>
                      {m.attachments.length} attachment{m.attachments.length > 1 ? "s" : ""}
                    </Text>
                  </View>
                )}
              </View>
              {m.unread && (
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: radius.sm,
                    backgroundColor: colors.primary,
                  }}
                />
              )}
            </Pressable>
          ))
        ) : (
          <Empty
            icon={Inbox}
            title={query ? "No matching messages" : "Nothing in your inbox"}
            detail={
              query
                ? "Try a different name or subject."
                : "Connect Google in Connections to read your mail here."
            }
          />
        )}
      </Card>
    </View>
  );
}
interface CalendarChoice {
  id: string;
  name: string;
  timeZone: string;
  accessRole: string;
}
function plusDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function CalendarScreen() {
  const { workspace: w, api, open } = useWorkspace();
  const [date, setDate] = useState(todayDate());
  const [all, setAll] = useState(false);
  const [calendars, setCalendars] = useState<CalendarChoice[]>([]);
  const [calendarId, setCalendarId] = useState("primary");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const selected = calendars.find((c) => c.id === calendarId);
  const zone = selected?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const writable = !selected || ["owner", "writer"].includes(selected.accessRole);
  const anchor = new Date(`${date}T12:00:00`);
  const dates = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(anchor);
    day.setDate(anchor.getDate() - anchor.getDay() + i);
    return day;
  });
  useEffect(() => {
    let active = true;
    void api
      .request<CalendarChoice[]>("/api/calendars")
      .then((items) => {
        if (!active) return;
        setCalendars(items);
        setCalendarId((current) =>
          items.some((c) => c.id === current) ? current : items[0]?.id || "primary",
        );
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, retry]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void Promise.resolve()
      .then(() => {
        const query = new URLSearchParams({
          calendarId,
          timeMin: zonedInstant(date, "00:00", zone),
          timeMax: zonedInstant(plusDays(date, all ? 30 : 1), "00:00", zone),
        });
        return api.request<CalendarEvent[]>(`/api/calendar/events?${query}`);
      })
      .then((items) => {
        if (active) setEvents(items.sort((a, b) => a.start.localeCompare(b.start)));
      })
      .catch((e) => {
        if (active) {
          setEvents([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, calendarId, date, all, zone, w, retry]);
  function newEvent() {
    open({
      type: "event",
      neighbors: events,
      draft: {
        calendarId,
        title: "",
        start: zonedInstant(date, "09:00", zone),
        end: zonedInstant(date, "10:00", zone),
        allDay: false,
        timeZone: zone,
        location: "",
        description: "",
        attendees: [],
      },
    });
  }
  return (
    <View style={{ gap: 20 }}>
      <View style={[s.between, { gap: 12, flexWrap: "wrap" }]}>
        <View style={[s.row, { gap: 8 }]}>
          <Text style={s.title}>
            {anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </Text>
          <IconButton
            icon={ChevronLeft}
            label="Previous week"
            onPress={() => setDate(plusDays(date, -7))}
          />
          <IconButton
            icon={ChevronRight}
            label="Next week"
            onPress={() => setDate(plusDays(date, 7))}
          />
        </View>
        <Button primary icon={Plus} disabled={!writable} onPress={newEvent}>
          New event
        </Button>
      </View>
      {calendars.length > 0 && (
        <View style={{ gap: 9 }}>
          <Text style={s.label}>Your calendars</Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {calendars.map((c) => (
              <Button
                key={c.id}
                small
                primary={c.id === calendarId}
                onPress={() => setCalendarId(c.id)}
              >
                {c.name}
                {["owner", "writer"].includes(c.accessRole) ? "" : " · read only"}
              </Button>
            ))}
          </View>
        </View>
      )}
      <Card style={{ padding: 12 }}>
        <View style={{ flexDirection: "row", gap: 5 }}>
          {dates.map((day) => {
            const key = localDateTime(
              day.toISOString(),
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            ).date;
            return (
              <Pressable
                key={key}
                onPress={() => {
                  setDate(key);
                  setAll(false);
                }}
                style={{
                  flex: 1,
                  alignItems: "center",
                  paddingVertical: 17,
                  gap: 9,
                  borderRadius: radius.lg,
                  backgroundColor: key === date ? colors.primarySoft : "transparent",
                }}
              >
                <Text style={s.small}>{day.toLocaleDateString("en-US", { weekday: "short" })}</Text>
                <Text
                  style={[
                    s.title,
                    {
                      fontSize: fontSize.title,
                      color: key === date ? colors.primaryText : colors.text,
                    },
                  ]}
                >
                  {day.getDate()}
                </Text>
                <View
                  style={{
                    height: 4,
                    width: 4,
                    borderRadius: radius.sm,
                    backgroundColor: [...events, ...w.events].some(
                      (e) => e.calendarId === calendarId && eventDate(e) === key,
                    )
                      ? colors.primary
                      : "transparent",
                  }}
                />
              </Pressable>
            );
          })}
        </View>
      </Card>
      <Card>
        <View style={[s.between, { gap: 10, flexWrap: "wrap" }]}>
          <Text style={s.heading}>
            {all
              ? "The next 30 days"
              : dateLabel(`${date}T12:00:00`, { weekday: "long", month: "long", day: "numeric" })}
          </Text>
          <Button small onPress={() => setAll(!all)}>
            {all ? "Selected day" : "Next 30 days"}
          </Button>
        </View>
        <Text style={[s.small, { marginTop: 7, marginBottom: 13 }]}>
          {selected?.name || "Your calendar"} · {zone}. Events show their own time zone.
        </Text>
        <ErrorNotice error={error} />
        {!!error && (
          <Button small onPress={() => setRetry(retry + 1)}>
            Try again
          </Button>
        )}
        {loading ? (
          <Pending label="Checking your calendar…" height={160} />
        ) : events.length ? (
          events.map((e, i) => (
            <View key={e.id}>
              {all && <Text style={[s.label, { marginTop: 16 }]}>{dateLabel(e.start)}</Text>}
              <AgendaRow event={e} index={i} neighbors={events} />
              <Text style={[s.small, { marginLeft: 84, marginBottom: 8 }]}>{e.timeZone}</Text>
            </View>
          ))
        ) : (
          !error && (
            <Empty
              icon={CalendarDays}
              title="A little open space"
              detail={
                all
                  ? "There’s nothing scheduled for the next 30 days."
                  : "There’s nothing on the calendar for this day."
              }
            >
              {writable && (
                <Button icon={Plus} onPress={newEvent}>
                  Add an event
                </Button>
              )}
            </Empty>
          )
        )}
      </Card>
    </View>
  );
}
export function BrowserScreen() {
  const { workspace: w, api, refresh, open } = useWorkspace();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    setError("");
    setBusy(true);
    try {
      const browser = await api.request<BrowserSession>("/api/browsers", { url });
      await refresh();
      setUrl("");
      open({ type: "browser", browser });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 24 }}>
      <Card style={{ backgroundColor: colors.primarySoft }}>
        <View style={[s.row, { gap: 12, marginBottom: 15 }]}>
          <Globe2 size={22} color={colors.primary} />
          <View>
            <Text style={s.heading}>A place for your open tabs</Text>
            <Text style={s.muted}>Browse in a private, persistent workspace session.</Text>
          </View>
        </View>
        <View style={[s.row, { gap: 10 }]}>
          <TextInput
            accessibilityLabel="Website address"
            value={url}
            onChangeText={setUrl}
            onSubmitEditing={() => void create()}
            autoCapitalize="none"
            placeholder="https://example.com"
            placeholderTextColor={colors.muted}
            style={[s.input, { flex: 1 }]}
          />
          <Button
            primary
            icon={Plus}
            busy={busy}
            disabled={!url.trim()}
            onPress={() => void create()}
          >
            Open session
          </Button>
        </View>
        <ErrorNotice error={error} />
      </Card>
      <Card>
        <SectionHeading title="Browser sessions" />
        {w.browsers.length ? (
          w.browsers.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => open({ type: "browser", browser: b })}
              style={{
                borderTopWidth: 1,
                borderTopColor: colors.line,
                paddingVertical: 20,
                gap: 12,
              }}
            >
              <View style={[s.row, { gap: 14 }]}>
                <View style={s.iconBox}>
                  <Globe2 size={20} color={colors.primary} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.heading}>{b.title || "Browser session"}</Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {b.url}
                  </Text>
                </View>
                <Chip tint={b.status === "active" ? colors.successBg : colors.canvas}>
                  {b.status}
                </Chip>
                <ArrowUpRight size={17} color={colors.muted} />
              </View>
              {!!b.previewUrl && (
                <Image
                  source={{ uri: api.url(b.previewUrl) }}
                  resizeMode="cover"
                  style={{
                    height: 180,
                    width: "100%",
                    borderRadius: radius.lg,
                    backgroundColor: colors.canvas,
                  }}
                />
              )}
            </Pressable>
          ))
        ) : (
          <Empty
            icon={Globe2}
            title="Start with a website"
            detail="Open a session above to keep your browsing together. Live previews appear when the browser worker is configured."
          />
        )}
      </Card>
    </View>
  );
}
export function FilesScreen() {
  const { workspace: w, api, refresh, open } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload() {
    setError("");
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      let artifact: Artifact;
      if (Platform.OS === "web") {
        const form = new FormData();
        if (!file.file)
          throw new Error("The selected file could not be read. Please choose it again.");
        form.append("file", file.file, file.name);
        artifact = await api.request<Artifact>("/api/files", form);
      } else {
        const result = await FileSystem.uploadAsync(api.url("/api/files"), file.uri, {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: "file",
          mimeType: "application/pdf",
          headers: { Authorization: `Bearer ${api.token}` },
        });
        const payload = JSON.parse(result.body);
        if (result.status < 200 || result.status >= 300)
          throw new Error(payload.error || "Could not import this PDF.");
        artifact = payload;
      }
      await refresh();
      open({ type: "file", file: artifact });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 20 }}>
      <View style={s.between}>
        <Text style={[s.muted, { flex: 1, marginRight: 15 }]}>
          Documents, with a little room to work.
        </Text>
        <Button primary icon={Upload} busy={busy} onPress={() => void upload()}>
          Import PDF
        </Button>
      </View>
      <ErrorNotice error={error} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 18 }}>
        {w.files.map((f) => (
          <Pressable
            key={f.id}
            onPress={() => open({ type: "file", file: f })}
            style={{ flexGrow: 1, flexBasis: 250, maxWidth: 430 }}
          >
            {({ hovered }: WebPressState) => (
              <Card
                style={{
                  padding: 0,
                  overflow: "hidden",
                  borderRadius: radius.xxl,
                  ...(hovered
                    ? { boxShadow: shadow.raised, borderColor: colors.lineStrong }
                    : null),
                }}
              >
                <View
                  style={{
                    height: 175,
                    backgroundColor: colors.surfaceMuted,
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <View
                    style={{
                      width: 93,
                      height: 121,
                      borderRadius: radius.sm,
                      backgroundColor: colors.surface,
                      padding: 14,
                      transform: [{ rotate: "-4deg" }],
                      borderWidth: 1,
                      borderColor: colors.line,
                    }}
                  >
                    <View style={[s.row, { gap: 5, marginBottom: 15 }]}>
                      <FileText size={13} color={colors.primary} />
                      <Text style={{ fontSize: 7, color: colors.primaryText }}>DOCUMENT</Text>
                    </View>
                    {[100, 75, 90, 95, 60].map((width, i) => (
                      <View
                        key={width}
                        style={{
                          height: 3,
                          backgroundColor: i === 0 ? colors.primarySoftStrong : colors.surfaceHover,
                          width: `${width}%`,
                          marginBottom: 7,
                          borderRadius: radius.sm,
                        }}
                      />
                    ))}
                  </View>
                  <View style={{ position: "absolute", bottom: 12, right: 14 }}>
                    <Chip>PDF</Chip>
                  </View>
                </View>
                <View style={{ padding: 20, gap: 6 }}>
                  <Text numberOfLines={1} style={s.heading}>
                    {f.name}
                  </Text>
                  <Text style={s.small}>
                    {f.pageCount} {f.pageCount === 1 ? "page" : "pages"} ·{" "}
                    {Math.max(1, Math.round(f.size / 1024))} KB
                  </Text>
                  <View style={[s.between, { marginTop: 8 }]}>
                    <Chip>{f.source}</Chip>
                    <Text style={s.small}>{dateLabel(f.createdAt)}</Text>
                  </View>
                </View>
              </Card>
            )}
          </Pressable>
        ))}
      </View>
      {!w.files.length && (
        <Card>
          <Empty
            icon={FileText}
            title="Your documents live here"
            detail="Import a PDF or open a mail attachment to read, fill supported form fields, and share a copy."
          />
        </Card>
      )}
    </View>
  );
}
export function ActivityScreen() {
  const { workspace: w, open } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const pending = w.actions.filter((a) => a.status === "awaiting_review");
  const actions = w.actions.filter((a) => filter === "all" || a.status === "awaiting_review");
  return (
    <View style={{ gap: 20 }}>
      <View style={[s.row, { gap: 10 }]}>
        <Button small primary={filter === "all"} onPress={() => setFilter("all")}>
          All activity
        </Button>
        <Button small primary={filter === "review"} onPress={() => setFilter("review")}>
          Needs review · {pending.length}
        </Button>
      </View>
      {actions.length > 0 && (
        <Card>
          <SectionHeading title="Reviews" />
          {actions.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => open({ type: "review", action: a })}
              style={[
                s.row,
                { gap: 15, paddingVertical: 17, borderTopWidth: 1, borderTopColor: colors.line },
              ]}
            >
              <View
                style={[
                  s.iconBox,
                  {
                    backgroundColor:
                      a.status === "awaiting_review" ? colors.warningBg : colors.successBg,
                  },
                ]}
              >
                {a.status === "awaiting_review" ? (
                  <ShieldCheck size={18} color={colors.text} />
                ) : (
                  <CheckCheck size={18} color={colors.text} />
                )}
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={s.text}>{a.title}</Text>
                <Text style={s.small}>
                  {a.createdByName ? `${a.createdByName} · ` : ""}
                  {relativeDate(a.createdAt)}
                </Text>
              </View>
              <Chip
                tint={
                  a.status === "failed"
                    ? colors.dangerBg
                    : a.status === "awaiting_review"
                      ? colors.warningBg
                      : colors.canvas
                }
              >
                {a.status.replace(/_/g, " ")}
              </Chip>
              <ChevronRight size={16} color={colors.muted} />
            </Pressable>
          ))}
        </Card>
      )}
      {filter === "all" && (
        <Card>
          <SectionHeading title="Workspace timeline" />
          {w.activity.length ? (
            w.activity.map((a, i) => (
              <View
                key={a.id}
                style={[
                  s.row,
                  {
                    alignItems: "flex-start",
                    gap: 17,
                    paddingVertical: 18,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: colors.line,
                  },
                ]}
              >
                <View
                  style={[s.iconBox, { height: 36, width: 36, backgroundColor: colors.canvas }]}
                >
                  <Clock3 size={16} color={colors.muted} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.text}>{a.title}</Text>
                  <Text style={s.muted}>{resultSummary(a.detail)}</Text>
                  <Text style={s.small}>
                    {dateLabel(a.date)} · {timeLabel(a.date)}
                  </Text>
                </View>
                <Chip>{a.status}</Chip>
              </View>
            ))
          ) : (
            <Empty
              icon={Clock3}
              title="The beginning of something lighter"
              detail="Your actions and their results will be recorded here."
            />
          )}
        </Card>
      )}
      {filter === "review" && !actions.length && (
        <Card>
          <Empty
            icon={ShieldCheck}
            title="You’re all caught up"
            detail="When an email or calendar change needs your approval, it will appear here."
          />
        </Card>
      )}
    </View>
  );
}
export function ConnectionsScreen({ query = "" }: { query?: string }) {
  const { workspace: w, api, refresh, notify, open } = useWorkspace();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function connect(capability: "read" | "write") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ url: string | null; connected?: boolean }>(
        "/api/google/connect",
        { capability },
      );
      if (result.url) {
        await Linking.openURL(result.url);
        notify("Finish connecting in your browser, then refresh your workspace.");
      } else {
        await refresh();
        notify("Local Google data is ready.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/google/disconnect", {});
      await refresh();
      notify("Google disconnected.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const google = w.connections.find((c) => c.id === "google");
  const connected = google?.status === "connected" || google?.status === "sample";
  const driveGranted =
    google?.capabilities?.some((capability) => capability.includes("/auth/drive")) ?? false;
  const canSend =
    google?.capabilities?.some((capability) => capability.includes("gmail.send")) ?? false;
  const rows = [
    { id: "gmail", name: "Gmail", icon: Mail, color: brand.gmail, connected, group: "google" },
    {
      id: "calendar",
      name: "Google Calendar",
      icon: CalendarDays,
      color: brand.googleCalendar,
      connected,
      group: "google",
    },
    {
      id: "drive",
      name: "Google Drive",
      icon: HardDrive,
      color: brand.googleDrive,
      connected: connected && driveGranted,
      group: "google",
    },
    {
      id: "browser",
      name: "Agent computer",
      icon: Globe2,
      color: brand.browser,
      connected: w.connections.some((c) => c.id === "browser" && c.status === "connected"),
      group: "browser",
    },
    {
      id: "openbot",
      name: "OpenBot",
      icon: Sparkles,
      color: brand.openbot,
      connected: false,
      group: "openbot",
    },
  ].filter((row) => `${row.name} ${row.group}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <View style={{ gap: 24 }}>
      {[true, false].map((isConnected) => {
        const group = rows.filter((row) => row.connected === isConnected);
        if (!group.length) return null;
        return (
          <View key={String(isConnected)} style={{ gap: 10 }}>
            <Text style={[s.label, { marginLeft: 16 }]}>
              {isConnected
                ? w.mode === "sample"
                  ? "Your connections"
                  : "Connected"
                : "Available integrations"}
            </Text>
            <View
              style={{
                paddingHorizontal: 16,
                borderRadius: radius.xl,
                backgroundColor: colors.surfaceMuted,
              }}
            >
              {group.map((row, index) => (
                <Pressable
                  key={row.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Manage ${row.name}`}
                  onPress={() =>
                    row.group === "browser" ? open({ type: "computer" }) : setSelected(row.group)
                  }
                  style={[
                    s.row,
                    {
                      gap: 16,
                      minHeight: 64,
                      borderBottomWidth: index < group.length - 1 ? 1 : 0,
                      borderBottomColor: colors.line,
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: radius.md,
                      backgroundColor: colors.surface,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <row.icon size={20} color={row.color} />
                  </View>
                  <Text style={[s.text, { flex: 1, fontWeight: "500" }]}>{row.name}</Text>
                  {row.connected && row.group === "google" && w.mode === "sample" && (
                    <Text style={s.small}>Local data</Text>
                  )}
                  {row.connected ? (
                    <ChevronRight size={18} color={colors.subtle} />
                  ) : (
                    <Text
                      style={{
                        fontSize: fontSize.ui,
                        fontWeight: "600",
                        color: row.group === "google" ? colors.primaryText : colors.muted,
                      }}
                    >
                      {row.group === "google" ? "Connect" : "Setup"}
                    </Text>
                  )}
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
      {!rows.length && <Text style={s.muted}>No matching connectors.</Text>}
      {selected && (
        <Sheet
          title={selected === "google" ? "Google connection" : "OpenBot"}
          subtitle={selected === "google" ? google?.account : "A computer for your agent"}
          onClose={() => setSelected(undefined)}
        >
          {selected === "google" ? (
            <View style={{ gap: 18 }}>
              <Text style={s.muted}>
                {connected
                  ? "One Google account is connected for your whole team. Everyone sees its mail, calendar and Drive, and anyone can approve what Hive prepares for it."
                  : "Connect one Google account for your whole team: Gmail, Google Calendar, and Google Drive, shared by everyone. Choose read access, then enable sending and editing when you need it."}
              </Text>
              {connected && google?.account && (
                <SettingsLine
                  label="Connected account"
                  value={
                    google.connectedBy
                      ? `${google.account} · by ${google.connectedBy}`
                      : google.account
                  }
                />
              )}
              <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
                {google?.capabilities.map((cap) => (
                  <Chip key={cap}>{capabilityLabel(cap)}</Chip>
                ))}
              </View>
              <ErrorNotice error={error} />
              {!connected && (
                <Button busy={busy} primary icon={Link2} onPress={() => void connect("read")}>
                  Connect Google
                </Button>
              )}
              {(!connected || (w.mode === "live" && !canSend)) && (
                <Button busy={busy} onPress={() => void connect("write")}>
                  Enable sending & editing
                </Button>
              )}
              {connected && (
                <Button busy={busy} danger onPress={() => void disconnect()}>
                  Disconnect Google
                </Button>
              )}
              <SettingsLine
                label="Environment"
                value={w.mode === "sample" ? "Local · example data" : "Live workspace"}
              />
              <SettingsLine label="Assistant" value="OpenCode" />
              <SettingsLine
                label="Rich Threads"
                value={w.runtime.richThreads ? "CopilotKit Intelligence" : "Not connected"}
              />
              <Button
                small
                icon={ArrowDownToLine}
                onPress={() => void refresh().catch((e) => setError(String(e)))}
              >
                Refresh connections
              </Button>
            </View>
          ) : (
            <View style={{ gap: 14 }}>
              <Text style={s.text}>
                The OpenBot adapter is available in this open-source project. A live OpenBot backend
                has not been configured.
              </Text>
              <Text style={s.muted}>
                Your current computer uses Hive’s persistent Chromium worker. OpenBot integration
                will expand the execution backend while keeping this interface.
              </Text>
            </View>
          )}
        </Sheet>
      )}
    </View>
  );
}
function SettingsLine({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={[
        s.between,
        { gap: 15, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
      ]}
    >
      <Text style={s.muted}>{label}</Text>
      <Text style={[s.text, { fontSize: fontSize.caption, flexShrink: 1, textAlign: "right" }]}>
        {value}
      </Text>
    </View>
  );
}

function capabilityLabel(value: string) {
  const scope = value.split("/").at(-1) || value;
  const names: Record<string, string> = {
    "gmail.readonly": "Read Gmail",
    "gmail.send": "Send Gmail",
    "calendar.events.readonly": "Read calendar events",
    "calendar.calendarlist.readonly": "Read calendar list",
    "calendar.events": "Manage calendar events",
    "calendar.readonly": "Read calendars",
    "drive.readonly": "Read Google Drive",
    "drive.file": "Manage Drive files",
  };
  return names[scope] || scope;
}
