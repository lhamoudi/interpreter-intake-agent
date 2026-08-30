/**
 * Human handoff for the voice-only TAC deployment.
 *
 * TAC's `createStudioHandoffTool` is explicitly NOT available in voice-only mode
 * (it needs Conversation Orchestrator + Memory). The documented voice-only path
 * is to set `session.pendingHandoffData` directly: the voice channel then emits
 * the ConversationRelay WS `end` message carrying `handoffData`, which
 * ConversationRelay POSTs verbatim to the `<Connect action>` URL. We build the
 * TAC-shaped payload here so that wire mechanism is exercised correctly.
 *
 * The PRIMARY handoff is Studio → Flex: when TWILIO_STUDIO_HANDOFF_FLOW_SID is
 * set, TAC wires the ConversationRelay `<Connect action>` URL to that Flow, and
 * the pendingHandoffData is delivered to it to create a Flex/TaskRouter task.
 *
 * The email path below is a FALLBACK only, used when no Studio Flow is
 * configured, so a lead is never dropped in a bare deployment. With Flex wired
 * it stays dormant. (Same proven SendGrid path as the video deflection.)
 */

import sgMail from '@sendgrid/mail';
import { createLogger, maskPhone } from 'twilio-agent-connect';
import { type IntakeRecord, summarize } from './intake.js';

const log = createLogger({ name: 'handoff' });

let sendgridReady = false;
function initSendgrid(): void {
  if (sendgridReady) return;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('SENDGRID_API_KEY not set');
  sgMail.setApiKey(key);
  sendgridReady = true;
}

/**
 * The TAC voice-handoff payload, as a JSON *string* (ConversationRelay forwards
 * it verbatim). Shape is ours — the receiving `<Connect action>` handler decides
 * what to do with it; here it documents the completed request for whoever picks
 * the call up downstream.
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

export interface HandoffNotifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Email the duty interpreter the collected lead so they can call the caller
 * back. Best-effort: a failure is logged and reported but never blocks the call
 * from completing — the request is already persisted in Turso either way.
 */
export async function notifyDutyInterpreter(
  conversationId: string,
  record: IntakeRecord,
): Promise<HandoffNotifyResult> {
  const to = process.env.DUTY_INTERPRETER_EMAIL;
  const from = process.env.SENDGRID_FROM_EMAIL;
  if (!to || !from) {
    return { ok: false, reason: 'DUTY_INTERPRETER_EMAIL / SENDGRID_FROM_EMAIL not set' };
  }

  const urgent = record.urgency === 'now';
  const lines = [
    `Language: ${record.sourceLanguage ?? '?'} to ${record.targetLanguage ?? 'English'}`,
    `Gender preference: ${record.genderPreference ?? 'no preference'}`,
    `Subject area: ${record.industry ?? 'not specified'}`,
    `Timing: ${record.urgency === 'now' ? 'NEEDED NOW' : 'scheduled / callback'}`,
    `Callback number: ${record.callbackNumber ?? '(none given)'}`,
    record.notes ? `Notes: ${record.notes}` : undefined,
  ].filter(Boolean);

  try {
    initSendgrid();
    await sgMail.send({
      to,
      from,
      subject: `${urgent ? '[URGENT] ' : ''}Interpreter request — ${record.sourceLanguage ?? 'unknown'} (${record.industry ?? 'general'})`,
      text: `A caller completed an interpreter intake. Please call them back.\n\n${lines.join('\n')}\n\nSummary: ${summarize(record)}\nConversation: ${conversationId}`,
    });
    log.info(
      { conversationId, callbackNumber: record.callbackNumber ? maskPhone(record.callbackNumber) : undefined, urgent },
      'duty interpreter notified',
    );
    return { ok: true };
  } catch (err) {
    log.error({ conversationId, err }, 'failed to notify duty interpreter');
    return { ok: false, reason: 'notification email failed' };
  }
}
