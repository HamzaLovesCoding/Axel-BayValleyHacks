import type { AssistantRequest, Command, Interpretation } from "./command";
import { BRAND } from "./site";
import { pronoun, slotAt, type Slot } from "./tray";

// Keyword-matching stand-in for the AI model. It runs when no API key is set, and on the phone if
// the server can't be reached. Anywhere its answers show up, the UI labels them as the demo.

// Hints for the default items, so "I'm so thirsty" still brings the water. Renamed slots only
// match by name.
const HINTS: Record<string, RegExp> = {
  water: /\b(thirsty|parched|a drink|something to drink|dry mouth)\b/,
  pills: /\b(medicine|meds|medication|tablets?)\b/,
  glasses: /\b(can'?t see|specs|spectacles|blurry)\b/,
  keys: /\b(going out|heading out|leaving|lock the door)\b/,
  phone: /\b(call|text|ring) (someone|my|her|him|them)\b/,
  remote: /\b(tv|television|telly|channel|volume)\b/,
  book: /\b(bored|something to read|my novel)\b/,
};

const STOP = /\b(stop|halt|freeze|hold on|wait)\b/;
const RETURN = /\b(put (it|them|that|those|this|these|the [a-z ]+?) back|return (it|them|the [a-z ]+)|take (it|them) back)\b/;
const RELEASE = /\b(release|let go|let it go|open (the |your )?(gripper|hand|claw)|(i'?ve )?got (it|them))\b/;
const ASK = /\b(?:bring|get|fetch|grab|hand|pass|give)\b(?:\s+me)?(?:\s+(?:the|my|a|an|some))?\s+([a-z][a-z' -]{1,30})/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Speech-to-text often splits the name ("bay valley"), so allow a space between any two letters.
const WAKE = new RegExp(`^(hey |ok |okay )?${BRAND.toLowerCase().split("").map(escape).join("\\s?")}[,.!]?\\s*`);

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”"]/g, "")
    .trim()
    .replace(WAKE, "");
}

function mentions(text: string, slot: Slot) {
  const name = slot.name.trim().toLowerCase();
  if (!name) return false;
  const forms = name.endsWith("s") ? [name, name.slice(0, -1)] : [name, `${name}s`];
  return forms.some((f) => new RegExp(`\\b${escape(f)}\\b`).test(text));
}

const label = (slot: Slot) => slot.name.trim().toLowerCase();

function list(tray: Slot[]) {
  const names = tray.map(label).filter(Boolean);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "nothing");
}

const answer = (reply: string, understood: string, command: Command | null): Interpretation => ({
  reply,
  understood,
  command,
  source: "keywords",
});

export function interpretKeywords({ text: raw, tray, holding, lastFetched, presenting }: AssistantRequest): Interpretation {
  const text = normalize(raw);
  const named = tray.find((slot) => mentions(text, slot));

  // While the open gripper waits for the item, "wait" means "not yet", not "stop".
  if (presenting != null && /\b(wait|hold on)\b/.test(text) && !/\b(stop|halt|freeze)\b/.test(text))
    return answer("No rush. Say go when it's in my hand.", "Keep waiting", null);

  if (STOP.test(text)) return answer("Stopping.", "Stop the arm", { action: "stop" });

  if (presenting != null && /^(go|ok|okay|got it|take it)[.!?]*$/.test(text)) {
    const slot = slotAt(tray, presenting);
    return answer(`Putting the ${slot ? label(slot) : "item"} back.`, "Take it and put it back", { action: "take", position: presenting });
  }

  if (RETURN.test(text)) {
    const slot = named ?? slotAt(tray, holding ?? lastFetched);
    if (!slot) return answer("There's nothing to put back right now.", "Put something back", null);
    return answer(`Putting the ${label(slot)} back.`, `Put the ${label(slot)} back`, {
      action: "return",
      position: slot.position,
    });
  }

  if (RELEASE.test(text)) return answer("Letting go.", "Open the gripper", { action: "release" });

  if (named) {
    return answer(`Bringing you the ${label(named)}.`, `Bring the ${label(named)}`, {
      action: "fetch",
      position: named.position,
    });
  }

  const hinted = tray.find((slot) => HINTS[label(slot)]?.test(text));
  if (hinted) {
    return answer(
      `Sounds like you could use the ${label(hinted)}. Bringing ${pronoun(hinted.name)} over.`,
      `Bring the ${label(hinted)}`,
      { action: "fetch", position: hinted.position },
    );
  }

  const asked = text.match(ASK)?.[1]?.replace(/\b(please|now|over|here)\b.*$/, "").trim();
  if (asked) {
    return answer(`I don't see ${asked} on the tray. It has the ${list(tray)}.`, `Bring ${asked}`, null);
  }

  return answer(`Sorry, I didn't catch which item. Try “bring me the ${label(tray[1] ?? tray[0])}”.`, "Not sure", null);
}
