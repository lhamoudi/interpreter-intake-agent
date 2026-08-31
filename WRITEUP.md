# Write-up — Interpreter Intake Agent

## The use case, and why

I swapped the default real-estate scenario for **over-the-phone interpretation (OPI)
intake** — a domain I know to production depth. I was previously embedded with a large
interpretation provider's development team, where we built out their IVR intake flow and the
overflow routing and orchestration behind it. So I'm not improvising this design; I'm building
the piece I'd most want to *upgrade* in a system I've actually shipped: the front door.

That real system routes overflow demand to partner interpreter networks with TaskRouter and
Flex, but the intake in front of it is a **fixed-path, DTMF-only IVR** — one intent at a time,
menu by menu. Replacing it with a conversational, agentic IVR is exactly what ConversationRelay
and Agent Connect are for: a caller can voice several intents at once, in any order — *"I need a
Spanish-to-English interpreter, male, for a doctor visit, and I need them immediately"* — and the
agent captures all of it, confirms, and routes in one turn. That acceleration matters for the
medical practitioners, lawyers, and community workers who need an interpreter the moment they're
with someone who doesn't speak their language.

The use case also carries an AI challenge real estate lacks — **the caller may not speak
English**, making language handling a genuine accessibility concern — and it's a hard-real-time
triage problem where *the handoff is the product*, which exercises the human-handoff bonus
naturally. `docs/overflow-network-integration.md` sketches how this front door slots into the
overflow network downstream.

## Twilio primitives used, and why

- **Agent Connect (TAC) + ConversationRelay** for the voice channel. TAC owns the
  WebSocket loop, TwiML, ASR/TTS and session lifecycle; I drive its `onMessageReady`
  callback. Running the *stock* `TACServer` unmodified was a deliberate choice — it kept
  the surface I own small and removed a whole class of porting risk (see "what I'd change").
- **ConversationRelay `<Connect action>` → Studio Flow → Flex** for the human handoff. TAC
  is in voice-only mode, where its built-in `createStudioHandoffTool` isn't available, so I
  use the documented voice-only path: set `session.pendingHandoffData`, and TAC emits the
  WebSocket `end` message that triggers the Studio Flow, which sends the live call into Flex
  as a task carrying the full intake context.
- **Twilio Video** for the deflection tier — a real WebRTC room created per request.
- **SendGrid** (Twilio-owned) to email the video join link.
- **DTMF + speech** via ConversationRelay config (spoken ten-digit strings transcribe badly).

## Architectural overview — components, data flow, state

A caller hits the Twilio number → `POST /twiml` returns
`<Connect><ConversationRelay wss://…/ws>` → ConversationRelay holds a WebSocket open for
the whole call and streams transcribed turns to `onMessageReady`, which calls the agent
(`src/agent.ts`). The agent is a **Claude tool-use loop**: Claude proposes structured values
through tools (`record_intake`, `choose_service_tier`, `request_handoff`, `decline_request`);
the server decides what to do with them.

**How the agent decides it has enough info** — the headline design decision. It doesn't
decide alone. Claude fills slots via `record_intake`, but a **deterministic server-side
check** (`checkComplete` against `REQUIRED_SLOTS` in `src/intake.ts`) gates the handoff.
Completeness is code, not model judgement.

**Where state lives:** in-flight call state is an in-process map keyed by `conversationId`
(correct on a single always-on machine); each completed request is written to Turso
(`requests`); cross-call memory is a salted **hash of the caller number** in `callers`,
which is what lets a returning caller be recognised. Failures degrade rather than crash: a
Turso outage is caught and logged, and a mid-call hang-up flushes the partial record as
`abandoned`.

**The differentiator — tiered deflection.** Once intake is complete, the agent offers three
service tiers with an explicit cost framing: AI (cheapest), human (premium, live transfer),
or a **video room** whose link is emailed. This models the *customer's unit economics* — the
video/WebRTC path removes PSTN per-minute cost — which is the kind of tradeoff an interpreter
network actually optimises. Any failure in the video path falls back to a human rather than
dead-ending the caller.

## What I built with agentic coding, and how I planned it

Effectively all of it, with Claude Code, and this write-up's own trail is part of the answer.
I planned before building: researched the real TAC/ConversationRelay API surface against the
installed package (not from memory), made the load-bearing decisions up front (use case, model,
host, persistence, which bonuses), and time-boxed the one genuine risk. The build was
verification-driven — each feature has a runnable smoke script under `src/smoke/` that exercises
the real agent against scripted turns, plus a unit test suite around the completeness gate. That
loop caught real bugs a demo would have surfaced live: an agent turn that spoke only a tool call
and produced dead air; "use the number I'm calling from" not resolving because the caller ID was
hashed for memory but never surfaced to the model; a mid-call language switch that changed the
TTS accent but not the words. Where a fix couldn't be verified without a phone, I said so and we
tested by ear on real calls.

## What I'd build next (another week)

- **Cross-channel (SMS ⇄ voice).** The agent loop is already channel-agnostic, so adding
  `SMSChannel` alongside `VoiceChannel` gives interchangeable booking by text or voice, with
  the SMS path resolving to an emailed/texted video link. It's a small build — **blocked only
  by A2P/toll-free SMS verification** on this account, which I ran into for real (below).
- **A member portal + 10-digit code identity.** Members register (email) and get a code the
  IVR validates first; the caller is then *identified*, so the video link goes to the email on
  file and the SMS-delivery problem disappears. This turns the caller-hash memory into a real
  member identity.
- **Live AI interpretation** as an actual operating mode (bidirectional real-time translation),
  which the "AI" tier currently offers but routes to a human.
- **A Flex plugin** rendering the handoff attributes as a clean card — or, since the customer
  already has an interpreter Flex plugin, mapping our task attributes onto its existing fields.

## What I'd change for production

- **Horizontal scale.** In-flight state is single-instance today. To scale, each call's state
  moves to a per-call actor (a Durable Object / actor-per-`CallSid`) so any node can serve any
  socket. Naming this is the point; building it isn't worth the take-home hours.
- **Hardening** the explicit non-goals: webhook signature validation is on, but I'd add
  structured retries around Turso, rate limiting, and proper secret rotation.
- **Deliverability** for the video email (SPF/DKIM on the sending domain — it currently lands
  in spam as a fresh sender), and real toll-free/10DLC registration to unlock SMS.

## What surprised me / got stuck on

- **A2P 10DLC blocked SMS outright** (error 30034) the moment I tried to text the video link
  from a local number. That single carrier-compliance fact reshaped two features: the video
  link moved to **email**, and the whole cross-channel bonus became gated on toll-free
  verification. It's the clearest reminder that on telephony, compliance is architecture.
- **Mid-call language switching was a rabbit hole.** `set_language` sent the exact message
  Twilio documents and ConversationRelay accepted the STT switch — but the TTS stayed English
  because the stock TwiML declared no `<Language>` voice for the target locale; declaring one
  with a bare `code` then broke the call entirely; and even once the voice switched, the model
  kept *writing* English (accent changed, words didn't). Each layer was a separate fix. It
  worked, but it was fragile enough that I ultimately cut it to keep the core solid — a
  deliberate "two working features beat five broken ones" call.
- **Voice-only mode changes the handoff API.** The obvious `createStudioHandoffTool` throws in
  voice-only mode; the correct path (`pendingHandoffData`) is different and worth knowing.
