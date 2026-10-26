import { UserMinus, UserPlus } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  Project,
  ProjectAccess,
  ProjectMember,
  ProjectRole,
} from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { accessChoices, roleChoices } from "./project-text";
import { Button, Chip, colors, ErrorNotice, Pending, SectionHeading, s } from "./ui";
import { useWorkspace } from "./workspace";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How open a project is: one of three, each with what it means. */
export function AccessChoice({
  value,
  onChange,
  disabled,
}: {
  value: ProjectAccess;
  onChange: (access: ProjectAccess) => void;
  disabled?: boolean;
}) {
  return (
    <View style={{ gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel="Who can see it">
      {accessChoices.map((choice) => {
        const on = choice.id === value;
        return (
          <Pressable
            key={choice.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => onChange(choice.id)}
            style={[
              s.row,
              {
                gap: 12,
                alignItems: "flex-start",
                padding: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: on ? colors.primary : colors.line,
                backgroundColor: on ? colors.primarySoft : colors.surface,
                opacity: disabled ? 0.6 : 1,
              },
            ]}
          >
            <View
              style={{
                width: 18,
                height: 18,
                marginTop: 2,
                borderRadius: 9,
                borderWidth: 1.5,
                borderColor: on ? colors.primary : colors.lineStrong,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {on && (
                <View
                  style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }}
                />
              )}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[s.text, { fontWeight: "600" }]}>{choice.title}</Text>
              <Text style={s.small}>{choice.detail}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

interface Known {
  email: string;
  name: string;
  role: "owner" | "admin" | "member" | "guest";
}

/** Who is in a project and what each may do; for its admins, a way to add, change and remove them. */
export function ProjectPeople({ project }: { project: Project }) {
  const { api } = useWorkspace();
  const { refresh } = useAgentWorkspace();
  const [known, setKnown] = useState<Known[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const canManage = !!project.you?.canManage;
  const members = project.members ?? [];

  useEffect(() => {
    let live = true;
    api
      .request<Known[]>("/api/agent/projects/people")
      .then((people) => live && setKnown(people))
      // A guest is not told who else is here: they see the addresses.
      .catch(() => live && setKnown([]));
    return () => {
      live = false;
    };
  }, [api]);

  const change = useCallback(
    async (what: string, next: ProjectMember[]) => {
      setBusy(what);
      setError("");
      try {
        await api.request(`/api/agent/projects/${project.id}`, { members: next }, "PATCH");
        await refresh();
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy("");
      }
    },
    [api, project.id, refresh],
  );

  const nameOf = (email: string) => known?.find((person) => person.email === email)?.name || email;
  const named = new Set(members.map((member) => member.email));
  const candidates = (known ?? []).filter((person) => !named.has(person.email));

  return (
    <View style={{ gap: 14 }}>
      <SectionHeading title={`People · ${members.length}`} />
      <ErrorNotice error={error} />
      {members.length === 0 && (
        <Text style={s.muted}>
          No one is named. Owners and admins of the workspace can always see it.
        </Text>
      )}
      {members.map((member) => (
        <View key={member.email} style={{ gap: 8 }}>
          <View style={[s.between, { gap: 12 }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.text} numberOfLines={1}>
                {nameOf(member.email)}
              </Text>
              {nameOf(member.email) !== member.email && (
                <Text style={s.small} numberOfLines={1}>
                  {member.email}
                </Text>
              )}
            </View>
            {!canManage && (
              <Chip>{roleChoices.find((role) => role.id === member.role)?.title}</Chip>
            )}
          </View>
          {canManage && (
            <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
              {roleChoices.map((role) => (
                <Button
                  key={role.id}
                  small
                  primary={member.role === role.id}
                  disabled={!!busy}
                  accessibilityLabel={`Make ${nameOf(member.email)} ${role.title.toLowerCase()}`}
                  onPress={() =>
                    member.role !== role.id &&
                    void change(
                      `role:${member.email}`,
                      members.map((m) => (m.email === member.email ? { ...m, role: role.id } : m)),
                    )
                  }
                >
                  {role.title}
                </Button>
              ))}
              <Button
                small
                icon={UserMinus}
                disabled={!!busy}
                accessibilityLabel={`Remove ${nameOf(member.email)}`}
                onPress={() =>
                  void change(
                    `remove:${member.email}`,
                    members.filter((m) => m.email !== member.email),
                  )
                }
              >
                Remove
              </Button>
            </View>
          )}
        </View>
      ))}
      {canManage && (
        <View style={{ gap: 12 }}>
          <SectionHeading title="Add people" />
          {known === null ? (
            <Pending height={60} />
          ) : candidates.length === 0 ? (
            <Text style={s.muted}>Everyone who has signed in here is in it already.</Text>
          ) : (
            candidates.map((person) => (
              <View key={person.email} style={[s.between, { gap: 12 }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.text} numberOfLines={1}>
                    {person.name || person.email}
                  </Text>
                  <Text style={s.small} numberOfLines={1}>
                    {[person.role === "guest" ? "Guest" : "", person.name ? person.email : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <Button
                  small
                  icon={UserPlus}
                  busy={busy === `add:${person.email}`}
                  disabled={!!busy}
                  accessibilityLabel={`Add ${person.name || person.email} to this project`}
                  onPress={() =>
                    void change(`add:${person.email}`, [
                      ...members,
                      { email: person.email, role: "member" as ProjectRole },
                    ])
                  }
                >
                  Add
                </Button>
              </View>
            ))
          )}
        </View>
      )}
    </View>
  );
}
