/**
 * Tiered-service deflection — the FDE-economics differentiator.
 *
 * Once the required intake is complete, the caller is offered three ways to be
 * served, with an explicit cost/tradeoff framing:
 *   - AI interpretation now       — cheapest (roadmap; not a built operating mode)
 *   - human interpreter, live     — premium (transferred on this call into Flex)
 *   - Twilio Video Room link      — WebRTC, good for screensharing / paper
 *                                   documents, and removes PSTN per-minute cost
 *
 * Only the Video Room path is actually actioned here: we create a real Twilio
 * Video Room and EMAIL the caller a join link (via SendGrid, Twilio-owned).
 *
 * Why email, not SMS: US A2P 10DLC registration gates SMS from local numbers
 * (unregistered sends fail with Twilio error 30034 — hit live on this account).
 * Email sidesteps that carrier gate entirely. The production vision (a member
 * portal + 10-digit code identity, so the email is always on file) is documented
 * in WRITEUP as roadmap; for now the agent collects an email only on the video
 * tier.
 *
 * Live AI interpretation is a different operating mode (bidirectional real-time
 * translation) and is intentionally left as roadmap. The human path reuses the
 * existing handoff/persistence flow.
 *
 * No join-page UI is built (an explicit non-goal); the link points at a viewer
 * URL derived from VIDEO_JOIN_BASE_URL, defaulting to a documented placeholder
 * so the flow is demonstrable end-to-end.
 */

import twilio from 'twilio';
import sgMail from '@sendgrid/mail';
import { createLogger } from 'twilio-agent-connect';

const log = createLogger({ name: 'deflection' });

let client: ReturnType<typeof twilio> | null = null;
let sendgridReady = false;

function twilioClient(): ReturnType<typeof twilio> {
  if (client) return client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  client = twilio(sid, token);
  return client;
}

function initSendgrid(): void {
  if (sendgridReady) return;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('SENDGRID_API_KEY not set');
  sgMail.setApiKey(key);
  sendgridReady = true;
}

/** Lightweight email-shape check — enough to avoid an obviously bad send. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export interface VideoDeflectionResult {
  ok: boolean;
  roomSid?: string;
  roomName?: string;
  joinUrl?: string;
  reason?: string;
}

/**
 * Create a Twilio Video Room and email the caller a join link.
 *
 * `toEmail` is the address the caller gave for the video session. Returns
 * ok:false with a reason on any failure — the caller flow degrades to a live
 * human transfer rather than dead-ending.
 */
export async function deflectToVideoRoom(
  conversationId: string,
  toEmail: string | undefined,
): Promise<VideoDeflectionResult> {
  if (!toEmail || !looksLikeEmail(toEmail)) {
    return { ok: false, reason: 'no valid email address to send the video link to' };
  }
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (!fromEmail) {
    return { ok: false, reason: 'SENDGRID_FROM_EMAIL not set' };
  }

  try {
    const c = twilioClient();

    // A short-lived, single-purpose room keyed to this call. This account only
    // accepts type "group" — go/group-small/peer-to-peer all return Twilio error
    // 53126 ("Legacy room type no longer supported") here, verified by probing
    // every type against the live account. "group" supports screensharing and
    // documents, which is the point of the video deflection.
    const roomName = `opi-${conversationId.slice(0, 24)}-${Date.now().toString(36)}`;
    const room = await c.video.v1.rooms.create({
      uniqueName: roomName,
      type: 'group',
      emptyRoomTimeout: 30, // minutes; auto-clean if nobody joins
    });

    // The room is real; the join PAGE is intentionally not built (the assignment
    // lists UI as an explicit non-goal). VIDEO_JOIN_BASE_URL is a placeholder, so
    // the link is well-formed and carries the real room name but has no page to
    // land on yet. Wiring a minimal Twilio Video JS join page + token endpoint is
    // the documented next step — see WRITEUP.
    const base = process.env.VIDEO_JOIN_BASE_URL ?? 'https://video.example.com/join';
    const joinUrl = `${base}?room=${encodeURIComponent(room.uniqueName)}`;
    const isPlaceholder = base.includes('video.example.com');

    initSendgrid();
    await sgMail.send({
      to: toEmail,
      from: fromEmail,
      subject: 'Your interpreter video session is ready',
      text:
        'Your interpreter video session is ready.\n\n' +
        `Join here (voice or video, and you can share your screen or documents): ${joinUrl}\n\n` +
        (isPlaceholder
          ? '(Demo note: the video session room is real, but the join page itself is not built ' +
            'in this prototype, so this link will not open a live session yet.)\n\n'
          : '') +
        'This link is good for the next little while. See you there.',
      html:
        '<p>Your interpreter video session is ready.</p>' +
        `<p><a href="${joinUrl}">Join your session</a> — voice or video, and you can share ` +
        'your screen or documents.</p>' +
        (isPlaceholder
          ? '<p style="color:#888;font-size:12px">Demo note: the video session room is real, but ' +
            'the join page itself is not built in this prototype, so this link will not open a ' +
            'live session yet.</p>'
          : ''),
    });

    log.info(
      { conversationId, roomSid: room.sid, emailed: true },
      'video deflection: room created + link emailed',
    );
    return { ok: true, roomSid: room.sid, roomName: room.uniqueName, joinUrl };
  } catch (err) {
    log.error({ conversationId, err }, 'video deflection failed');
    return { ok: false, reason: 'could not set up the video session' };
  }
}
