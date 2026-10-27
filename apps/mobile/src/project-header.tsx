import UserPlus from "lucide-react-native/dist/esm/icons/user-plus";
import Users from "lucide-react-native/dist/esm/icons/users";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Project } from "../../../packages/domain/src/agent";
import { initialsOf, markRow } from "./project-text";
import { authorTint } from "./theme";
import { colors, fontSize, IconButton, s, type WebPressState } from "./ui";
import { useWorkspace } from "./workspace";

const MARK = 28;

/**
 * Who is in a project, on its page: a row of marks, with the rest as a number, that opens the project's
 * people; and, for its admins, a button to add someone. An open project is everyone's, so it says so
 * instead. Names are read from the people the workspace knows, as the address is all a project keeps.
 */
export function ProjectPeopleStack({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const { api } = useWorkspace();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const members = project.members ?? [];
  const everyone = (project.access ?? "open") === "open";
  useEffect(() => {
    if (everyone) return;
    let live = true;
    api
      .request<{ email: string; name: string }[]>("/api/agent/projects/people")
      .then((people) => live && setNames(new Map(people.map((p) => [p.email, p.name]))))
      // A guest is not told who else is here: the marks go by the address.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, everyone]);

  const label = everyone
    ? `Everyone in the workspace can see ${project.name}. Open its people`
    : `${members.length} ${members.length === 1 ? "person" : "people"} in ${project.name}: ${members
        .map((m) => names.get(m.email) || m.email)
        .join(", ")}`;
  const { shown, more } = markRow(members);
  return (
    <View style={[s.row, { gap: 4 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onOpen}
        style={({ hovered }: WebPressState) => ({
          flexDirection: "row",
          alignItems: "center",
          height: 36,
          paddingLeft: 6,
          paddingRight: 10,
          borderRadius: 18,
          backgroundColor: hovered ? colors.surfaceHover : "transparent",
        })}
      >
        {everyone ? (
          <View style={[s.row, { gap: 6, paddingLeft: 6 }]}>
            <Users size={15} color={colors.muted} />
            <Text style={[s.small, { fontSize: fontSize.ui, fontWeight: "500" }]}>Everyone</Text>
          </View>
        ) : (
          <>
            {shown.map((member, at) => {
              const name = names.get(member.email) ?? "";
              return (
                <View
                  key={member.email}
                  style={{
                    width: MARK + 4,
                    height: MARK + 4,
                    borderRadius: (MARK + 4) / 2,
                    marginLeft: at === 0 ? 0 : -6,
                    borderWidth: 2,
                    borderColor: colors.canvas,
                    backgroundColor: authorTint(name || member.email),
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ fontSize: 10, fontWeight: "700", color: colors.text }}>
                    {initialsOf(name, member.email)}
                  </Text>
                </View>
              );
            })}
            {more > 0 && (
              <View
                style={{
                  width: MARK + 4,
                  height: MARK + 4,
                  borderRadius: (MARK + 4) / 2,
                  marginLeft: -6,
                  borderWidth: 2,
                  borderColor: colors.canvas,
                  backgroundColor: colors.surfaceMuted,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ fontSize: 10, fontWeight: "700", color: colors.muted }}>
                  +{more}
                </Text>
              </View>
            )}
          </>
        )}
      </Pressable>
      {project.you?.canManage && (
        <IconButton icon={UserPlus} label={`Add people to ${project.name}`} onPress={onOpen} />
      )}
    </View>
  );
}
