# Write-up — Interpreter Intake Agent

## The use case, and why

I swapped the default real-estate scenario for **over-the-phone interpretation (OPI)
intake** — a domain I know to production depth. I was previously embedded with a large
interpretation provider's development team, where I guided them in building out their IVR intake 
flow and the overflow routing and orchestration behind it. So I'm not improvising this design; 
I'm actually building the piece I'd most want to *upgrade*: the front door.

That real system routes overflow demand to partner interpreter networks with TaskRouter and
Flex, but the intake in front of it is a **fixed-path, DTMF-only IVR** — one intent at a time,
menu by menu. Replacing it with a conversational, agentic IVR is exactly what ConversationRelay
and Agent Connect are for: a caller can voice several intents at once, in any order — *"I need a
Spanish-to-English interpreter, male, for a doctor visit, and I need them immediately"* — and the
agent captures all of it, confirms, and routes in one turn. That acceleration matters for the
medical practitioners, lawyers, and community workers who need an interpreter the moment they're
with someone who doesn't speak their language.

In this use case, the handoff to the interpreter ***IS*** the product, so capturing every critical 
intent via the intake flow is non-negotiable.  

The use case also carries an AI challenge real estate lacks — **the caller may not speak English**, 
making language handling a genuine accessibility concern. This is something an agentic AI IVR can 
excel at - with Twilio's ConversationRelay supporting multilingual voice agents.

`docs/overflow-network-integration.md` sketches how this front door slots into the
overflow network downstream.

## Twilio primitives used, and why

- **Agent Connect (TAC) + ConversationRelay** for the voice channel. TAC owns the
  WebSocket loop, TwiML, ASR/TTS and session lifecycle; I drive its `onMessageReady`
  callback. Running the *stock* `TACServer` unmodified was a deliberate choice — it kept
  the surface I own small and removed a whole class of porting risk (see "what I'd change").
- **Studio Flow → Flex** for the human handoff — a **live transfer**, not a message to a queue:
  the caller stays on the line and is connected to an interpreter who accepts the task in Flex,
  with the captured intake riding along as **task attributes** so they don't re-qualify the
  caller. The mechanism is a voice-only-mode subtlety worth knowing: TAC's convenience helper
  `createStudioHandoffTool` throws in voice-only mode (it needs Conversation Orchestrator), so I
  use the documented path — set `session.pendingHandoffData` (`buildHandoffData` in
  `src/handoff.ts`); TAC emits a ConversationRelay `end` message that ConversationRelay POSTs to
  the `<Connect action>` URL, wired to the "TAC Handoff to Agent" Studio Flow, whose Send-to-Flex
  widget creates the TaskRouter task.
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
installed package, and made the pivotal decisions up front (use case, model, hosting,
persistence, which bonuses). The one genuine technical risk was hosting: an early plan put the
app on Cloudflare Workers (as I routinely use this paid service for personal MCP servers and 
CRON jobs), but Fastify can't run there due to no port binding, which would have required a lot 
of TAC rework/porting for little benefit. Rather than gamble time on the tech stack, I went with 
Fly.io to run the stock `TACServer` unmodified (so there was nothing to port). 

The build was verification-driven — each feature has a runnable smoke script under `src/smoke/` 
that exercises the real agent against scripted turns, plus a unit test suite around the completeness 
gate. That loop caught real bugs a demo would have surfaced live: an agent turn that spoke only a tool call
and produced dead air; "use the number I'm calling from" not resolving because the caller ID was
hashed for memory but never surfaced to the model; a mid-call language switch that changed the
TTS accent but not the words. Where a fix couldn't be verified without a phone, Claude said so and we
tested by ear on real calls.

## What I'd build next (another week)

- **SMS channel .** The agent loop is already channel-agnostic, so adding `SMSChannel` alongside 
  `VoiceChannel` gives interchangeable booking by text or voice, with the SMS path resolving to 
  an emailed/texted video link. It's a small build — **blocked only by A2P/toll-free SMS 
  verification** on this account, which I ran into (below). SMS is also a perfect **deflection** 
  channel: to guide high-cost PSTN callers to the web portal (audio-only video room), where the 
  cost reduces to WebRTC pricing. We used email for this in the demo build - for ease of setup.
- **Integrate to customer's member portal platform + 10-digit code identity.** Members register
  online and get a unique code the IVR validates first; the caller is then *identified*, so the 
  video link goes to the caller's email. This turns the crude caller memory DB table into a real
  member identity, and improves over simply associating by caller ANI.
- **Live AI interpretation** as an actual operating mode (bidirectional real-time translation).
  It's offered in the demo build, but not built out. This is likely the direction the customer is
  moving in already from a product offering perspective. 
- **A Flex plugin** rendering the handoff attributes as a clean UI component — or, since the customer
  already has a robust interpreter Flex plugin, mapping our task attributes onto its existing fields.

## What I'd change for production

- **Horizontal scale.** Today each call's state lives in a plain in-memory map inside the one
  Node process (`const calls` in `agent.ts`), which is correct only because I run exactly one
  machine. Add a second machine and the state is trapped on whichever one first answered the
  call — any other machine has amnesia. To scale, each call's state moves to its own
  addressable per-call unit keyed by `CallSid` (a Cloudflare Durable Object), so any node can 
  look it up and serve any socket. 
- **Hardening.** For production I'd add: **retries with backoff around Turso** so a transient 
  network blip never drops a completed interpreter request (today a DB failure is caught and 
  logged); **rate limiting** per caller/IP on the public endpoints to cap abuse and runaway Twilio /
  Anthropic / Turso spend; and **secret rotation** — the API keys are set-once in Fly secrets
  today, and would move to short-lived, rotatable credentials in a secrets manager.
- **Deliverability** for the video email (needs SPF/DKIM records on the sending domain — as it 
  currently lands in spam as a fresh sender), and real toll-free/10DLC registration to unlock SMS.
- **AWS Stack.** I would likely opt away from the multiple vendors (Fly.io, Turso, Cloudflare) and 
  opt for the entire infrastructure living on the AWS stack (API Gateway, Lambdas, Dynamo, Route 53)
  - to better align with the customer's tech stack and simplify deployment, troubleshooting, 
  maintenance and observability.  

## What surprised me / got stuck on

- **A2P 10DLC blocked SMS outright** (error 30034) the moment I tried to text the video link
  from a local number. 10DLC or toll-free verification would have required more time and effort than
  the take-home hours afforded. As a result, the video room link sharing moved to **email**, and the 
  whole cross-channel bonus (**Conversation Orchestrator**) was also gated. 
- **Mid-call language switching was a rabbit hole.** `set_language` sent the exact message
  Twilio documents and ConversationRelay accepted the STT switch — but the TTS stayed English
  because the stock TwiML declared no `<Language>` voice for the target locale. I debugged and 
  made good progress, but ultimately it was deemed too much of a mini-project in its own right, and so
  was parked. It's clearly very doable though. 
