# Production context: slotting this front door into an interpreter-overflow network

*Conceptual architecture for the walkthrough. Nothing here is built or wired into the
repo — it explains how this intake agent would fit a real over-the-phone interpretation
(OPI) operation, using standard Twilio primitives. It describes an industry-standard
overflow pattern, not any specific employer's system or code.*

## The problem this front door feeds

A mid-size OPI provider staffs interpreters for common language pairs but cannot cover
every language, every hour. Demand is spiky and the SLA is tight (a caller needing a
medical interpreter *now* can't wait). The economics only work if overflow demand can be
routed to **partner** interpreter networks when in-house capacity is exhausted — without
the caller hearing the seams, and without losing reporting.

This intake agent is the **front door**: it answers instantly, qualifies the request
(language pair, gender, subject, urgency), and produces a structured, routable task. What
happens *after* handoff is the overflow-routing problem below.

## The routing pattern (Twilio primitives)

```
   Caller ─► Intake agent (this repo) ─► structured request
                                              │
                                              ▼
                                     TaskRouter Workflow
                          ┌───────────────────┼───────────────────┐
                          ▼                   ▼                    ▼
                   In-house queue      Partner A queue      Partner B queue …
                   (Flex agents)       (timeout ⇒ next)     (timeout ⇒ next)
                          │                   │
                          ▼                   ▼
                   Live interpreter    Bridge to partner
                                       (SIP / Application Connect)
```

- **TaskRouter Workflow** expresses the overflow policy declaratively: try the in-house
  queue for the language pair, and on timeout fall through to partner queues in priority
  order. The intake agent's captured attributes (language, gender, subject, urgency) are the
  task attributes the Workflow routes on.
- **The caller stays in one place** while routing happens — held in the queue on uniform
  hold music — so redirection never replaces their hold experience with a partner's. Only
  when an interpreter is secured is the call bridged.
- **Securing a partner interpreter** is done without prematurely sending the call: an
  orchestration layer asks the partner (via webhook, or a held SIP call) to secure an agent,
  and only bridges once the partner confirms an interpreter is on the line. This keeps
  per-minute cost off until it's actually needed and keeps the customer experience clean.
- **Twilio partners** can receive the bridged call via **Application Connect**; **SIP
  partners** via a SIP interface. The same secured-then-bridged shape works for both.

## Where the intake agent's output plugs in

Everything the agent captures is exactly what the router needs:

| Agent captures | Used downstream for |
|---|---|
| source/target language | queue selection (language-pair routing) |
| gender preference | worker attribute matching |
| subject area (medical/legal/community) | specialised-interpreter matching |
| urgency (now vs scheduled) | priority / SLA tier |
| service tier (human / video) | channel of the eventual connection |

The agent already emits these as Flex task attributes on handoff, so pointing its handoff
at an overflow Workflow instead of a single queue is a configuration change, not a rewrite.

## Reporting and state — the trade-off to name

The hard part of overflow routing is **visibility**: once a call is redirected/bridged to a
partner, the original TaskRouter task's lifecycle can be cut short, losing the single view of
total customer wait time. Two shapes trade off here:

- **One long task** for the whole customer journey → clean total-wait-time reporting, but no
  native per-partner granularity.
- **A task per partner attempt** (sharing a conversation ID) → native per-partner real-time
  and historical data, at the cost of the single wait-time view.

A production build picks one deliberately and fills the gap with a custom orchestration layer
that captures the events the native tools don't. That orchestration is the real engineering
in an overflow network; the intake agent in this repo is the piece that makes every one of
those routed tasks start with complete, structured context.

## Why the front door matters

Overflow routing is only as good as the request it routes. A voicemail or a half-filled form
produces a task a human has to re-qualify. This agent produces a **complete, validated,
attribute-rich task at the moment of the call** — which is what lets the automated overflow
policy run without a human in the middle for the common case.
