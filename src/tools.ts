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
        description: 'Subject area, if the caller indicates one. Optional.',
      },
      urgency: {
        type: 'string',
        enum: ['now', 'scheduled'],
        description: '"now" if they need an interpreter immediately, "scheduled" for later.',
      },
      callbackNumber: { type: 'string', description: 'Best number to reach them on.' },
      notes: { type: 'string', description: 'Anything else that matters for the interpreter. Optional.' },
    },
  },
};

export const SET_LANGUAGE: Anthropic.Tool = {
  name: 'set_language',
  description:
    'Switch the languages this call is spoken and transcribed in. Call this if the ' +
    'caller is clearly not comfortable in the current language — for example they greet ' +
    'you or answer in Spanish. Pass the plain English name of the language to switch to.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['language'],
    properties: {
      language: { type: 'string', description: 'Language to switch to, e.g. "Spanish", "Mandarin".' },
    },
  },
};

export const REQUEST_HANDOFF: Anthropic.Tool = {
  name: 'request_handoff',
  description:
    'Secure a human interpreter for this request. Only call this once you believe you ' +
    'have gathered every required detail and confirmed them with the caller. The system ' +
    'will validate completeness; if anything is missing it will tell you what to ask for.',
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
};

export const TOOLS: Anthropic.Tool[] = [RECORD_INTAKE, SET_LANGUAGE, REQUEST_HANDOFF];
