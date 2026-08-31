/**
 * Tool definitions the agent uses, as native Anthropic tool schemas.
 *
 * The model proposes structured values through these tools; the server decides
 * what to do with them. `record_intake` accepts partial updates (every field
 * optional) so the agent can fill slots as they come up in natural conversation
 * rather than as a rigid form.
 */

import type Anthropic from '@anthropic-ai/sdk';

export const RECORD_INTAKE: Anthropic.Tool = {
  name: 'record_intake',
  description:
    'Record or update what you have learned about the interpreter request. Call this ' +
    'whenever the caller gives you a new detail. All fields are optional — send only ' +
    'what you just learned; previous values are retained.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sourceLanguage: {
        type: 'string',
        description:
          'The language of the THIRD PARTY the caller needs interpreted — their patient, client, ' +
          'or the person they are trying to talk to, e.g. "Spanish", "Mandarin". You must ASK for ' +
          'this; it is NOT the language the caller is speaking to you (that is set_caller_language).',
      },
      targetLanguage: {
        type: 'string',
        description:
          'The language the third party is interpreted INTO — i.e. the caller\'s own language. ' +
          'This defaults to the language the caller is speaking to you (see set_caller_language); ' +
          'confirm it with them rather than asking from scratch.',
      },
      genderPreference: {
        type: 'string',
        enum: ['male', 'female', 'no_preference'],
        description: 'Preferred interpreter gender.',
      },
      industry: {
        type: 'string',
        enum: ['medical', 'legal', 'community'],
        description:
          'Subject area for interpreter matching. Map the caller\'s answer: healthcare / doctor / ' +
          'hospital / clinic / pharmacy → "medical"; court / lawyer / immigration / police / legal ' +
          'paperwork → "legal"; anything else (school, housing, benefits, utilities, general) → ' +
          '"community". Optional — omit if the caller is unsure or declines.',
      },
      notes: { type: 'string', description: 'Anything else that matters for the interpreter. Optional.' },
    },
  },
};

export const CHOOSE_SERVICE_TIER: Anthropic.Tool = {
  name: 'choose_service_tier',
  description:
    'Record which service option the caller chose after you have offered them the three ' +
    'ways to be served. Only call this once you have all required intake details and have ' +
    'presented the options and the caller has picked one. The options, with their tradeoffs:\n' +
    '  - "ai": an AI interpreter can assist right now on this call — the lowest-cost option.\n' +
    '  - "human": a professional human interpreter, connected live on this call — higher cost, ' +
    'best for sensitive or complex matters.\n' +
    '  - "video": we email them a link to join a video session, where they can use voice or ' +
    'video and share their screen or documents (for example a paper form or letter). This is ' +
    'also lower cost than a phone interpreter.\n' +
    'For "video", you MUST also pass the caller\'s email (the link is sent by email, not text); ' +
    'ask for it if you do not have it. For "human" the system transfers this live call. Report ' +
    'the chosen tier here.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tier'],
    properties: {
      tier: {
        type: 'string',
        enum: ['ai', 'human', 'video'],
        description: 'The option the caller chose.',
      },
      email: {
        type: 'string',
        description:
          "The caller's email address, REQUIRED when tier is \"video\" (the join link is " +
          'emailed). Omit for other tiers.',
      },
    },
  },
};

export const REQUEST_HANDOFF: Anthropic.Tool = {
  name: 'request_handoff',
  description:
    'Connect this live call to a human interpreter. Only call this once you have gathered ' +
    'every required detail, offered the caller their service options, and they chose the ' +
    'human option (or an AI/video option that has fallen back to a human). The system will ' +
    'validate completeness; if anything is missing it will tell you what to ask for.',
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
};

export const SET_CALLER_LANGUAGE: Anthropic.Tool = {
  name: 'set_caller_language',
  description:
    'Report the language the CALLER is speaking to you, detected from their words. Call this on ' +
    'your first turn and again ANY time the caller switches language mid-call. This is the ' +
    'language you converse in — it controls the voice you speak in and the transcription of what ' +
    'the caller says. It also defaults the interpreter\'s target language (what their third party ' +
    'gets interpreted into). It is NOT the third party\'s language (that is record_intake ' +
    'sourceLanguage). Only English, Spanish, and French are supported.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['language'],
    properties: {
      language: {
        type: 'string',
        enum: ['English', 'Spanish', 'French'],
        description: 'The language the caller is currently speaking to you.',
      },
    },
  },
};

export const DECLINE_REQUEST: Anthropic.Tool = {
  name: 'decline_request',
  description:
    'End the call when the caller is clearly not here for an interpreter — a wrong number, a ' +
    'sales/spam call, someone just testing, or an abusive caller. Only use this once it is clear; ' +
    'give a genuine caller the benefit of the doubt first. Pass a short reason for the record.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        enum: ['wrong_number', 'spam_or_sales', 'testing', 'abusive', 'other'],
        description: 'Why the caller is not a qualified interpreter request.',
      },
    },
  },
};

export const TOOLS: Anthropic.Tool[] = [
  SET_CALLER_LANGUAGE,
  RECORD_INTAKE,
  CHOOSE_SERVICE_TIER,
  REQUEST_HANDOFF,
  DECLINE_REQUEST,
];
