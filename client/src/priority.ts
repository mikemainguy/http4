// Which class a request is scheduled in (vrek iss-j9tm9w8).
//
// Strict shortest-remaining-first is a heuristic about size, not importance: a
// 400 KB critical bundle always loses to a 4 KB tracking pixel. A class lets
// the page say which matters, and the scheduler keeps SRPT inside each class.
//
// Two layers are implemented here, and they compose:
//
//   Level 0  the browser's own Request.destination, mapped to a default
//   Level 2  a `classes` map in the page's config, longest prefix wins
//
// Level 3 (a per-request option in JavaScript) and Level 4 (changing a live
// transfer) are separate work; this module only decides a class from what the
// worker already knows, so it is pure and testable without a browser.

/** Scheduling classes, most urgent first. The order here IS the priority order. */
export const CLASSES = ["critical", "normal", "background"] as const;
export type PriorityClass = (typeof CLASSES)[number];

/** 0 = most urgent. Also what GRANT's priority byte carries. */
export function classRank(c: PriorityClass): number {
  return CLASSES.indexOf(c);
}

export const DEFAULT_CLASS: PriorityClass = "normal";

/**
 * Level 0: a default class from Request.destination.
 *
 * Render-blocking resources are critical because the page cannot paint without
 * them. Media is background because nothing waits on it to become interactive
 * — it is the bulk SRPT exists to defer. Everything else, including fetch()
 * and XHR (destination ""), is normal: the app is running by then and knows
 * better than we do, so it can say so at Level 2 or 3.
 */
export function classForDestination(destination: string): PriorityClass {
  switch (destination) {
    case "style":
    case "script":
    case "font":
      return "critical";
    case "image":
    case "video":
    case "audio":
    case "track":
      return "background";
    default:
      return DEFAULT_CLASS;
  }
}

/** A validated `classes` map from the page's config: path prefix → class. */
export type ClassMap = ReadonlyArray<readonly [prefix: string, cls: PriorityClass]>;

/**
 * The allowlisted, validated form of a config's `classes` object. Anything
 * unrecognised is dropped rather than trusted, so a typo costs that rule and
 * not the session — the same treatment `tuning` gets (vrek dec-18b85wz).
 *
 * Sorted longest prefix first, so `/images/hero` beats `/images/` whatever
 * order the page wrote them in.
 */
export function classMap(raw: unknown): ClassMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const out: [string, PriorityClass][] = [];
  for (const [prefix, cls] of Object.entries(raw as Record<string, unknown>)) {
    if (!prefix.startsWith("/")) continue; // a path prefix, not a bare name
    if (typeof cls !== "string") continue;
    if (!(CLASSES as readonly string[]).includes(cls)) continue;
    out.push([prefix, cls as PriorityClass]);
  }
  out.sort((a, b) => b[0].length - a[0].length);
  return out;
}

/**
 * The class for one request: the longest matching prefix from the page's
 * config, else the destination's default. Pure; the caller supplies both.
 */
export function classFor(pathname: string, destination: string, map: ClassMap): PriorityClass {
  for (const [prefix, cls] of map) {
    if (pathname.startsWith(prefix)) return cls;
  }
  return classForDestination(destination);
}
