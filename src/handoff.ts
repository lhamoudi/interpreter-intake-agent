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
 * it verbatim to the `<Connect action>` URL / Studio Flow). Shape is ours — the
 * Studio Flow reads it into the Flex task attributes so the interpreter sees the
 * full request context on the incoming task.
 */
export function buildHandoffData(conversationId: string, record: IntakeRecord): string {
  return JSON.stringify({
    reason: 'interpreter_intake_complete',
    conversationId,
    serviceTier: record.serviceTier ?? 'human',
    request: {
      sourceLanguage: record.sourceLanguage,
      targetLanguage: record.targetLanguage,
      genderPreference: record.genderPreference,
      industry: record.industry,
      urgency: record.urgency,
      callbackNumber: record.callbackNumber,
      notes: record.notes,
    },
  });
}
