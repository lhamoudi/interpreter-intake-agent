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

import twilio from 'twilio';
import { createLogger, maskPhone } from 'twilio-agent-connect';
import { type IntakeRecord } from './intake.js';

const log = createLogger({ name: 'handoff' });

/**
 * The Flex task attributes for this request — shared by the live-transfer handoff
 * (wrapped as handoffData for the Studio Flow) and the directly-created callback
 * task. Everything the receiving interpreter sees lives here.
 */
export function buildTaskAttributes(
  conversationId: string,
  record: IntakeRecord,
): Record<string, unknown> {
  const languagePair = `${record.sourceLanguage ?? 'unknown'} → ${record.targetLanguage ?? 'English'}`;
  const urgent = record.urgency === 'now';
  const scheduled = record.urgency === 'scheduled';
  const industryLabel = record.industry ? record.industry[0].toUpperCase() + record.industry.slice(1) : 'General';
  const timeSuffix = scheduled && record.scheduledTimeText ? ` · ⏰ ${record.scheduledTimeText}` : '';

  return {
    name: `${urgent ? '🔴 ' : scheduled ? '📅 ' : ''}${languagePair}${record.industry ? ` · ${industryLabel}` : ''}${timeSuffix}`,
    customerName: `${languagePair} interpreter request`,
    // Top-level keys the stock Flex UI renders, so the interpreter sees the number
    // and callback time without a plugin.
    customerAddress: record.callbackNumber ?? undefined,
    callbackNumber: record.callbackNumber ?? undefined,
    callbackTime: record.scheduledTimeText ?? undefined,
    callbackTimeISO: record.scheduledTimeISO ?? undefined,
    type: scheduled ? 'interpreter_callback' : 'interpreter_intake',
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
      scheduledTimeText: record.scheduledTimeText ?? null,
      scheduledTimeISO: record.scheduledTimeISO ?? null,
      notes: record.notes ?? null,
    },
    conversations: {
      conversation_attribute_1: record.sourceLanguage ?? undefined,
      conversation_attribute_2: record.industry ?? undefined,
      conversation_attribute_3: urgent ? 'urgent' : 'scheduled',
    },
  };
}

/**
 * Create a TaskRouter task directly (NOT via the live-call Studio transfer) so a
 * scheduled caller can hang up and be called back. Flex shows it as a task the
 * interpreter actions at the requested time. Returns false on any failure.
 */
export async function createCallbackTask(
  conversationId: string,
  record: IntakeRecord,
): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const workspace = process.env.TWILIO_WORKSPACE_SID;
  const workflow = process.env.TWILIO_CALLBACK_WORKFLOW_SID;
  const taskChannel = process.env.TWILIO_CALLBACK_TASK_CHANNEL ?? 'default';
  if (!sid || !token || !workspace || !workflow) {
    log.error({ conversationId }, 'callback task env not set (TWILIO_WORKSPACE_SID/CALLBACK_WORKFLOW_SID)');
    return false;
  }
  try {
    const client = twilio(sid, token);
    const task = await client.taskrouter.v1.workspaces(workspace).tasks.create({
      workflowSid: workflow,
      taskChannel,
      attributes: JSON.stringify(buildTaskAttributes(conversationId, record)),
    });
    log.info(
      { conversationId, taskSid: task.sid, callbackNumber: record.callbackNumber ? maskPhone(record.callbackNumber) : undefined, when: record.scheduledTimeText },
      'callback task created',
    );
    return true;
  } catch (err) {
    log.error({ conversationId, err }, 'failed to create callback task');
    return false;
  }
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
 *    TaskInfoPanel) can render it as a clean card — see WRITEUP. Grouping it
 *    under one key keeps that plugin trivial and the raw view readable.
 */
export function buildHandoffData(conversationId: string, record: IntakeRecord): string {
  return JSON.stringify({ attributes: buildTaskAttributes(conversationId, record) });
}
