# Production context: slotting this front door into an interpreter-overflow network

*Conceptual architecture for the walkthrough. Nothing here is built or wired into the
repo - it explains how this intake agent would fit a real over-the-phone interpretation
(OPI) operation, using standard Twilio primitives. It describes an industry-standard
overflow pattern, not any specific employer's system or code.*

## The problem this front door feeds

A mid-size OPI provider staffs interpreters for common language pairs but cannot cover
every language, every hour. Demand is spiky and the SLA is tight (a caller needing a
medical interpreter *now* can't wait). The economics only work if overflow demand can be
routed to **partner** interpreter networks when in-house capacity is exhausted - without
the caller hearing the seams, and without losing reporting.

This intake agent is the **front door**: it answers instantly, qualifies the request
(language pair, gender, subject), and produces a structured, routable task. What
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
  order. The intake agent's captured attributes (language, gender, subject) are the
  task attributes the Workflow routes on.
- **The caller stays in one place** while routing happens - held in the queue on uniform
  hold music - so redirection never replaces their hold experience with a partner's. Only
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
| urgency *(roadmap - not captured by the current agent)* | priority / SLA tier |
| service tier (human / video) | channel of the eventual connection |

The agent already emits these as Flex task attributes on handoff, so pointing its handoff
at an overflow Workflow instead of a single queue is a configuration change, not a rewrite.

## Reporting and state - the task shape that gives both views

The hard part of overflow routing is **visibility**. Once a call is redirected or bridged to
a partner, a single TaskRouter task's lifecycle can be cut short, losing the view of total
customer wait time; but tracking each partner attempt as its own task loses that single view.
The shape that gets both is a **hybrid**, and it's the recommended pattern:

- **One long-running voice task = the caller's actual call.** It sits in a holding queue for
  the entire wait, until an interpreter is secured and the call is bridged. Because the call
  lives in this one task the whole time, it gives the single, clean view of **total customer
  wait time** - and uniform hold music throughout.
- **Plus a short-lived tracking task per partner attempt.** When the orchestration reaches a
  partner it creates a disposable "SLA tracking" task that dictates how long to wait for that
  partner; it's cancelled on answer, timeout, or SLA breach, and the next partner gets a fresh
  one. These give **per-partner real-time and historical visibility** without disturbing the
  long call task.

The two are linked by a conversation ID, so the per-attempt tasks roll up to the one journey.
This part - a database-backed orchestration layer that spawns and cancels the tracking tasks,
cycles through the partner list on breach, and re-enqueues the call to the original workflow
if every partner is exhausted - is most of the engineering work in an overflow network. The
intake agent in this repo is the piece that makes every one of those routed tasks start with
complete, structured context.

## Where the intake experience fits

Good overflow routing behind a slow intake still starts every call slowly. A fixed-path,
DTMF-only IVR makes the caller work through menus one intent at a time before any routing
happens.

Swapping the DTMF IVR for a conversational agent - Twilio Agent Connect and
ConversationRelay - lets the caller give several intents at once, in any order:
*"I need a Spanish-to-English interpreter, male, for a doctor visit, and I need them immediately."*
The agent captures it, confirms, and routes in one turn. That speed matters when someone
needs an interpreter right away - a doctor's visit, a legal appointment, a community intake
call.
