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
 * the receiving interpreter should see must live under `attributes`. Flex renders
 * task attributes in the agent panel; `name` becomes the task's display label.
 */
export function buildHandoffData(conversationId: string, record: IntakeRecord): string {
  const languagePair = `${record.sourceLanguage ?? 'unknown'} → ${record.targetLanguage ?? 'English'}`;
  return JSON.stringify({
    // Consumed by the Studio template → becomes the Flex task attributes.
    attributes: {
      // A readable task label for the Flex agent's queue.
      name: `Interpreter: ${languagePair}${record.industry ? ` (${record.industry})` : ''}`,
      type: 'interpreter_intake',
      conversationId,
      serviceTier: record.serviceTier ?? 'human',
      // The captured intake, flattened so each field shows in the Flex panel.
      sourceLanguage: record.sourceLanguage ?? null,
      targetLanguage: record.targetLanguage ?? 'English',
      languagePair,
      genderPreference: record.genderPreference ?? 'no_preference',
      industry: record.industry ?? null,
      urgency: record.urgency ?? null,
      callbackNumber: record.callbackNumber ?? null,
      notes: record.notes ?? null,
    },
  });
}
