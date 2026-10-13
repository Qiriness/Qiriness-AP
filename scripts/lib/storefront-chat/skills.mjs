/**
 * Skills: a bundle of instructions, tools and guardrails the storefront model
 * gets only while it needs them (owner, 2026-10-13). Outside a skill the
 * prompt stays short; inside it, the model has the skill's rules and tools.
 *
 *   a skill        { name, summary, instructions(ctx) → lines, tools(ctx) → definitions }
 *   use_skill      the one tool that opens a skill, always offered while no
 *                  skill is open; its description lists the skills
 *   active         decided by the conversation's state (the routine builder:
 *                  `mode === 'routine_builder'`), so the code can open a skill
 *                  too (« Oui » to the routine offer) and it stays open across turns
 */

import { ROUTINE_BUILDER } from './skills/routine-builder.mjs';

export const USE_SKILL = 'use_skill';
export const SKILLS = [ROUTINE_BUILDER];
const byName = new Map(SKILLS.map((s) => [s.name, s]));

export function skillNamed(name) {
  return byName.get(name) ?? null;
}

/** The skill open in this conversation, from its state, or null. */
export function activeSkill({ mode } = {}) {
  return SKILLS.find((s) => s.isActive({ mode })) ?? null;
}

export function useSkillDefinition(skills = SKILLS) {
  return {
    type: 'function',
    function: {
      name: USE_SKILL,
      description: `Open a skill: its instructions and tools for this conversation. Open one only when the customer asks for what it does, in their own words. Skills: ${skills.map((s) => `${s.name} (${s.summary})`).join('; ')}.`,
      strict: true,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', enum: skills.map((s) => s.name) } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  };
}

/** The prompt block of an open skill. */
export function skillBlock(skill, ctx) {
  return ['', `SKILL OPEN: ${skill.name} — ${skill.summary}`, ...skill.instructions(ctx)];
}
