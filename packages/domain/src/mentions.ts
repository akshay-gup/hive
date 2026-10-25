/**
 * Mentioning people in a message: `@max` names someone, and Hive is mentioned as `@hive`. The
 * handle is the part of a person's email address before the `@`, or the whole address where two
 * people would share it, so a handle names one person.
 */

/** A person who can be mentioned in a channel. */
export interface Mentionable {
  email: string;
  name: string;
  /** What is typed after the `@`. */
  handle: string;
  role: "owner" | "admin" | "member" | "guest";
}

const HANDLE_CHARS = "A-Za-z0-9";
/** `@` and a handle in running text, not the middle of a word or an email address. */
const MENTION = new RegExp(
  `(^|[^\\w@.+-])@([${HANDLE_CHARS}_](?:[${HANDLE_CHARS}._+-]*[${HANDLE_CHARS}_])?(?:@[${HANDLE_CHARS}-]+(?:\\.[${HANDLE_CHARS}-]+)+)?)`,
  "g",
);

/** The handles said in a text, lowercase and without the `@`, in order and without repeats. */
export function mentionsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION)) {
    const handle = match[2].toLowerCase();
    if (!found.includes(handle)) found.push(handle);
  }
  return found;
}

/** Each person's handle: the name part of the address, or all of it where that is shared. */
export function withHandles(
  people: { email: string; name: string; role: Mentionable["role"] }[],
): Mentionable[] {
  const local = (email: string) => email.split("@")[0].toLowerCase();
  const count = new Map<string, number>();
  for (const person of people)
    count.set(local(person.email), (count.get(local(person.email)) ?? 0) + 1);
  return people.map((person) => ({
    ...person,
    email: person.email.toLowerCase(),
    // `hive` is the agent's: no one is named by it, so a person whose address starts so is named by all of it.
    handle:
      (count.get(local(person.email)) ?? 0) > 1 || local(person.email) === "hive"
        ? person.email.toLowerCase()
        : local(person.email),
  }));
}

/** The people a text mentions, by their handles; a handle no one has names no one. */
export function mentionedPeople(text: string, people: Mentionable[]): Mentionable[] {
  const wanted = new Set(mentionsIn(text));
  return people.filter((person) => wanted.has(person.handle) || wanted.has(person.email));
}

/** The `@word` the cursor is in, if it is being typed: where it starts and what follows the `@`. */
export function activeMention(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const found = /(^|[\s(])@([A-Za-z0-9._+-]*)$/.exec(before);
  if (!found) return null;
  return { start: before.length - found[2].length - 1, query: found[2].toLowerCase() };
}

/** Who to offer for what has been typed after the `@`: names and handles that start with it first. */
export function matchPeople<T extends { name: string; handle: string }>(
  people: T[],
  query: string,
  limit = 6,
): T[] {
  const q = query.toLowerCase();
  const words = (person: T) => person.name.toLowerCase().split(/\s+/);
  const rank = (person: T) =>
    !q
      ? 2
      : person.handle.startsWith(q)
        ? 0
        : words(person).some((word) => word.startsWith(q))
          ? 1
          : person.handle.includes(q) || person.name.toLowerCase().includes(q)
            ? 3
            : -1;
  return people
    .map((person) => ({ person, score: rank(person) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.person.name.localeCompare(b.person.name))
    .slice(0, limit)
    .map((entry) => entry.person);
}

/** The text with the `@word` being typed made into the chosen handle, and where the cursor goes. */
export function insertMention(
  text: string,
  active: { start: number },
  cursor: number,
  handle: string,
): { text: string; cursor: number } {
  const insert = `@${handle} `;
  const after = text.slice(cursor);
  const spaced = after.startsWith(" ") ? after.slice(1) : after;
  return {
    text: text.slice(0, active.start) + insert + spaced,
    cursor: active.start + insert.length,
  };
}

/**
 * A text cut into plain pieces and the mentions in it that name someone, for drawing them apart. A mention
 * is drawn with the person's name where `names` has it: a handle is how someone is typed, not what they are called.
 */
export function splitMentions(
  text: string,
  handles: Iterable<string>,
  names?: ReadonlyMap<string, string>,
): { text: string; mention: boolean }[] {
  const known = new Set([...handles].map((handle) => handle.toLowerCase()));
  const pieces: { text: string; mention: boolean }[] = [];
  let at = 0;
  for (const match of text.matchAll(MENTION)) {
    if (!known.has(match[2].toLowerCase())) continue;
    const start = (match.index ?? 0) + match[1].length;
    if (start > at) pieces.push({ text: text.slice(at, start), mention: false });
    pieces.push({ text: `@${names?.get(match[2].toLowerCase()) ?? match[2]}`, mention: true });
    at = start + 1 + match[2].length;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), mention: false });
  return pieces;
}

/**
 * The text with each mention that names someone written as `@Name`: for a line shown away from the people it is
 * about (a notice, a preview), where a handle would only look like a code.
 */
export function namedMentions(text: string, people: Mentionable[]): string {
  const names = new Map<string, string>();
  for (const person of people) {
    const name = person.name.trim();
    if (!name) continue;
    names.set(person.handle.toLowerCase(), name);
    names.set(person.email.toLowerCase(), name);
  }
  return text.replace(MENTION, (whole, before: string, handle: string) => {
    const name = names.get(handle.toLowerCase());
    return name ? `${before}@${name}` : whole;
  });
}
