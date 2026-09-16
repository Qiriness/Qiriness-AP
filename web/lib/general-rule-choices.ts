/**
 * Which general rule a person picked for a branch, in the editor's « Use a
 * general rule », kept in this browser.
 *
 * FRONTEND ONLY, by request: nothing here reaches the agent, which uses a general
 * rule on a branch whenever that rule's own conditions hold, whatever was picked.
 * The pick is what turns the branch into « General rule applies » on the canvas;
 * where the picked rule would not actually be used there, the canvas says so
 * rather than letting the box claim coverage the agent does not apply.
 *
 * Keyed by answer rule KEY, not id: a rule deleted and restored gets a new id and
 * keeps its key. Per browser, and lost with site data — that is the price of not
 * touching the backend.
 */
const STORAGE_KEY = "rulebook.general-rule-choices.v1";

export type GeneralRuleChoices = Record<string, string>;

export function branchChoiceKey(answerSet: string, situationKey: string, need: string, finding: string): string {
  return [answerSet, situationKey, need, finding].join("|");
}

export function loadGeneralRuleChoices(): GeneralRuleChoices {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as GeneralRuleChoices) : {};
  } catch {
    return {};
  }
}

export function saveGeneralRuleChoices(choices: GeneralRuleChoices): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Private window or blocked storage: the pick lasts until the page reloads.
  }
}
