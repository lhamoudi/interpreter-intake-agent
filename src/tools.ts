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
      sourceLanguage: { type: 'string', description: 'The language the caller speaks, e.g. "Spanish".' },
      targetLanguage: { type: 'string', description: 'The language to interpret into. Usually "English".' },
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
    '  - "human": a professional human interpreter calls them back — higher cost, best for ' +
    'sensitive or complex matters.\n' +
    '  - "video": we email them a link to join a video session, where they can use voice or ' +
    'video and share their screen or documents (for example a paper form or letter). This is ' +
    'also lower cost than a phone interpreter.\n' +
    'For "video", you MUST also pass the caller\'s email (the link is sent by email, not text); ' +
    'ask for it if you do not have it. For "human" the system secures the callback. Report the ' +
    'chosen tier here.',
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
    'Secure a human interpreter callback for this request. Only call this once you have ' +
    'gathered every required detail, offered the caller their service options, and they chose ' +
    'the human-callback option (or an AI/video option that has fallen back to a human). The ' +
    'system will validate completeness; if anything is missing it will tell you what to ask for.',
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
};

export const TOOLS: Anthropic.Tool[] = [
  RECORD_INTAKE,
  CHOOSE_SERVICE_TIER,
  REQUEST_HANDOFF,
];
