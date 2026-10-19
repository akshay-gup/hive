import { useEffect, useState } from "react";
import { useWorkspace } from "./workspace";

/** What each workspace address said it can do, asked once. An address that cannot be asked has no list. */
const asked = new Map<string, Promise<string[]>>();

function featuresOf(baseUrl: string): Promise<string[]> {
  let known = asked.get(baseUrl);
  if (!known) {
    known = fetch(`${baseUrl}/api/health`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { features?: unknown } | null) =>
        Array.isArray(body?.features)
          ? body.features.filter((item): item is string => typeof item === "string")
          : [],
      )
      // Not being able to ask is not a reason to offer what may not be there: it is no features.
      .catch(() => []);
    asked.set(baseUrl, known);
  }
  return known;
}

/**
 * Does the workspace's server have this feature? False until it has answered, and for a server too
 * old to say, so a control is shown only when it will work.
 */
export function useServerFeature(name: string): boolean {
  const { api } = useWorkspace();
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    void featuresOf(api.baseUrl).then((list) => {
      if (live) setHas(list.includes(name));
    });
    return () => {
      live = false;
    };
  }, [api.baseUrl, name]);
  return has;
}
