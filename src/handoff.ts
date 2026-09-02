/**
 * Human handoff for the voice-only TAC deployment.
 *
 * TAC's `createStudioHandoffTool` is explicitly NOT available in voice-only mode
 * (it needs Conversation Orchestrator + Memory). The documented voice-only path
 * is to set `session.pendingHandoffData` directly: the voice channel then emits
 * the ConversationRelay WS `end` message carrying `handoffData`, which
 * ConversationRelay POSTs verbatim to the `<Connect action>` URL.
 *
 * When TWILIO_STUDIO_HANDOFF_FLOW_SID is configured, TAC wires that action URL
 * to the Studio Flow, which routes the call into Flex via TaskRouter with the
 * lead context below as task attributes. This module just builds the payload;
 * the routing lives in the Studio Flow.
 */

import { type IntakeRecord } from './intake.js';

/**
 * The Flex task attributes for this request. Every request is a live connect, so
 * the caller is on the line and the interpreter accepts this task.
 *
 * NOTE on visibility: only the top-level conventional keys (`name`, and to a
 * degree `customers.*`) render in Flex's STOCK TaskInfoPanel screen-pop. The
 * nested `interpreterRequest` object is on the task and readable by any plugin or
 * the API, but is NOT shown by the native UI without a Flex plugin. The customer
 * already runs an interpreter Flex plugin, so productionising this is mapping
 * these attributes onto that plugin's existing fields - not building UI here.
 */
export function buildTaskAttributes(
  conversationId: string,
  record: IntakeRecord,
): Record<string, unknown> {
  const languagePair = `${record.sourceLanguage ?? 'unknown'} → ${record.targetLanguage ?? 'English'}`;
  const industryLabel = record.industry ? record.industry[0].toUpperCase() + record.industry.slice(1) : 'General';

  return {
    name: `${languagePair}${record.industry ? ` · ${industryLabel}` : ''}`,
    customers: { name: `${languagePair} request` },
    type: 'interpreter_intake',
    conversationId,
    serviceTier: record.serviceTier ?? 'human',
    interpreterRequest: {
      languagePair,
      sourceLanguage: record.sourceLanguage ?? null,
      targetLanguage: record.targetLanguage ?? 'English',
      genderPreference: record.genderPreference ?? 'no_preference',
      industry: record.industry ?? null,
      notes: record.notes ?? null,
    },
    conversations: {
      conversation_attribute_1: record.sourceLanguage ?? undefined,
      conversation_attribute_2: record.industry ?? undefined,
    },
  };
}

/**
 * The TAC voice-handoff payload, as a JSON *string* (ConversationRelay forwards
 * it verbatim to the `<Connect action>` URL / Studio Flow).
 *
 * Shape is dictated by Twilio's "TAC Handoff to Agent" Studio template: it parses
 * this string and sets the Flex TASK ATTRIBUTES to the top-level `attributes`
 * object (`{{flow.variables.handoffData.attributes | to_json}}`). So everything
 * the receiving interpreter should see must live under `attributes`.
 *
 * How Flex presents these to the agent:
 *  - `name` → the task's title in the queue and call canvas. Keep it a tight
 *    one-line summary, not the whole record.
 *  - Flex's DEFAULT TaskInfoPanel renders a handful of conventional keys nicely
 *    (notably `customerName` and the `conversations.*` reporting keys). We set
 *    those so the agent sees useful context even with the stock UI.
 *  - `interpreterRequest` groups the full captured intake as labelled fields.
 *    The stock UI shows it as JSON; a small Flex plugin (TaskCanvasTabs /
 *    TaskInfoPanel) can render it as a clean card - see WRITEUP. Grouping it
 *    under one key keeps that plugin trivial and the raw view readable.
 */
export function buildHandoffData(conversationId: string, record: IntakeRecord): string {
  return JSON.stringify({ attributes: buildTaskAttributes(conversationId, record) });
}

/** A disposition that ends the call without sending it to Flex. */
export type TerminateDisposition = 'declined' | 'video_sent';

/**
 * Payload for ending a call that is NOT being transferred to a human - either a
 * declined (spam / wrong-number / not-a-lead) caller, or a caller who picked the
 * video tier and already has their join link (nothing left for a human to pick
 * up). Sent via the same ConversationRelay `end` mechanism as a handoff, so
 * control returns to the `<Connect action>` Studio Flow, but marked so the Flow
 * branches to a hang-up instead of Send-to-Flex.
 *
 * STUDIO FLOW CONTRACT: branch on `attributes.disposition`. When it is
 * `"declined"` or `"video_sent"`, run a Hangup (optionally a brief Say first).
 * Otherwise (unset) treat it as a normal interpreter handoff (Send-to-Flex). The
 * field lives under `attributes` to match how the Studio template parses
 * `handoffData`.
 */
export function buildTerminateData(
  conversationId: string,
  disposition: TerminateDisposition,
  reason: string,
  record: IntakeRecord = {},
): string {
  // Carry the SAME attribute shape as a real handoff (via buildTaskAttributes)
  // so any Studio parse/Set-Variables step that reads handoff fields
  // (interpreterRequest, languagePair, conversations.*) finds them and does not
  // throw on a non-Flex disposition - then layer the terminate markers on top.
  // The Flow still branches on `disposition` to hang up instead of Send-to-Flex.
  return JSON.stringify({
    attributes: {
      ...buildTaskAttributes(conversationId, record),
      disposition,
      declineReason: reason,
    },
  });
}
