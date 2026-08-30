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
 *    TaskInfoPanel) can render it as a clean card — see WRITEUP. Grouping it
 *    under one key keeps that plugin trivial and the raw view readable.
 */
export function buildHandoffData(conversationId: string, record: IntakeRecord): string {
  const languagePair = `${record.sourceLanguage ?? 'unknown'} → ${record.targetLanguage ?? 'English'}`;
  const urgent = record.urgency === 'now';
  const industryLabel = record.industry ? record.industry[0].toUpperCase() + record.industry.slice(1) : 'General';

  return JSON.stringify({
    attributes: {
      // --- Task title (queue + call canvas) ---
      name: `${urgent ? '🔴 ' : ''}${languagePair}${record.industry ? ` · ${industryLabel}` : ''}`,

      // --- Keys the STOCK Flex UI already renders ---
      // Flex's default TaskInfoPanel shows customerName prominently.
      customerName: `${languagePair} interpreter request`,

      // --- Structured record for a plugin / the raw attributes view ---
      type: 'interpreter_intake',
      conversationId,
      serviceTier: record.serviceTier ?? 'human',
      interpreterRequest: {
        languagePair,
        sourceLanguage: record.sourceLanguage ?? null,
        targetLanguage: record.targetLanguage ?? 'English',
        genderPreference: record.genderPreference ?? 'no_preference',
        industry: record.industry ?? null,
        urgency: record.urgency ?? null,
        urgent,
        callbackNumber: record.callbackNumber ?? null,
        notes: record.notes ?? null,
      },

      // --- Flex conversations/reporting keys (searchable, show in CRM strip) ---
      conversations: {
        conversation_attribute_1: record.sourceLanguage ?? undefined, // language
        conversation_attribute_2: record.industry ?? undefined, // subject area
        conversation_attribute_3: urgent ? 'urgent' : 'scheduled',
      },
    },
  });
}
