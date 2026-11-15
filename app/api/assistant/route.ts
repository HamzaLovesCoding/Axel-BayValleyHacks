import Anthropic from "@anthropic-ai/sdk";
import { connection } from "next/server";
import { interpretKeywords } from "@/lib/assistant";
import { parseAssistantRequest, parseCommand, type AssistantRequest, type Interpretation } from "@/lib/command";
import { BRAND } from "@/lib/site";
import { angleOf, slotAt } from "@/lib/tray";

// Sonnet 5.5 at low effort: picking one of seven items from a hint doesn't need Opus, and it keeps
// replies to a second or two. "claude-haiku-5-5" is cheaper still if it passes the same phrases.
const MODEL = "claude-sonnet-5-5";

const SYSTEM = `You are ${BRAND}, the voice of an assistive robot arm for a person with arthritis.
The arm sits in the middle of a round tray. Everyday items sit at numbered positions around it.

Turn what the person says into at most one command:
- fetch: bring the item at "position" to the person and hold it out.
- release: open the gripper so the person can take what the arm is holding.
- return: put the item at "position" back in its spot (the one being held, or the last one handed over).
- take: close on the item the person placed in the open gripper, then put it back. Only when presenting that position.
- stop: stop moving.
- none: no arm action. Answer briefly or ask one short question.

Infer the item from hints: "I'm so thirsty" means the water. If they ask for something that isn't on
the tray, say so and use none. People may start with "${BRAND}," as a wake word; ignore it.

"reply" is spoken aloud: one short, warm sentence, under 20 words, no markdown.
"understood" is a 2-5 word gloss for the screen, like "Bring the water".
When asked to return an item while "Holding" is nothing, the arm does not go to the tray: it comes to
the person with an open hand and waits. Then the reply must say that, like "Sure, I'll come and take
the glasses from you", and never that it is being put back yet. It does not close
until the person says "go", "ok", "okay", "got it" or "take it". While presenting, those phrases mean
take at the presenting position. Never infer take from a request to return or fetch.
"position" is the tray position for fetch, return and take, and 0 otherwise.`;

const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    understood: { type: "string" },
    action: { type: "string", enum: ["fetch", "release", "return", "take", "stop", "none"] },
    position: { type: "integer" },
  },
  required: ["reply", "understood", "action", "position"],
  additionalProperties: false,
};

function describeState({ tray, holding, lastFetched, presenting }: AssistantRequest) {
  const items = tray.map((s) => `${s.position}: ${s.name || "(empty)"} at ${angleOf(s.position)}°`).join("\n");
  const held = slotAt(tray, holding)?.name;
  const handed = slotAt(tray, lastFetched)?.name;
  return [
    `Tray:\n${items}`,
    `Holding: ${held ?? "nothing"}`,
    `Last handed over: ${handed ?? "nothing"}`,
    `Presenting an open gripper for: ${slotAt(tray, presenting)?.name ?? "nothing"}`,
  ].join("\n");
}

async function interpretWithModel(request: AssistantRequest): Promise<Interpretation> {
  const client = new Anthropic();
  const history: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of request.history) {
    // The API wants the conversation to start with the user, so drop a leading assistant turn.
    if (history.length === 0 && turn.role === "assistant") continue;
    history.push({ role: turn.role, content: turn.text });
  }

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    // Speed over depth: this is intent matching, not reasoning.
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    // If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [
      ...history,
      // Tray state goes in the newest message so the system prompt stays identical across requests.
      { role: "user", content: `${describeState(request)}\n\nThey said: "${request.text}"` },
    ],
  });

  if (response.stop_reason === "refusal") {
    return { reply: "Sorry, I can't help with that one.", understood: "Declined", command: null, source: "model" };
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`No text in response (stop_reason: ${response.stop_reason})`);

  const out = JSON.parse(text) as { reply: string; understood: string; action: string; position: number };
  return {
    reply: out.reply,
    understood: out.understood,
    command: parseCommand({ action: out.action, position: out.position }, request.tray),
    source: "model",
  };
}

// Lets the Setup screen say whether replies come from the model or the keyword demo.
export async function GET() {
  await connection();
  return Response.json({ model: Boolean(process.env.ANTHROPIC_API_KEY) });
}

export async function POST(req: Request) {
  const request = parseAssistantRequest(await req.json().catch(() => null));
  if (!request) return Response.json({ error: "Expected { text, tray, holding, lastFetched, history }" }, { status: 400 });

  if (!process.env.ANTHROPIC_API_KEY) return Response.json(interpretKeywords(request));

  try {
    return Response.json(await interpretWithModel(request));
  } catch (error) {
    // Keep the arm usable if the model call fails; the reply is labelled as the keyword demo.
    if (error instanceof Anthropic.AuthenticationError) console.error("ANTHROPIC_API_KEY was rejected");
    else if (error instanceof Anthropic.RateLimitError) console.error("Rate limited by the Claude API");
    else console.error("Assistant model call failed", error);
    return Response.json(interpretKeywords(request));
  }
}
