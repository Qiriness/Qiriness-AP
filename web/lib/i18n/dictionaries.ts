import { en } from "./en";
import { fr } from "./fr";
import type { Locale } from "./locales";
import type { Dictionary } from "./translate";

export const DICTIONARIES: Record<Locale, Dictionary> = { en, fr };
export const SOURCE_DICTIONARY: Dictionary = en;
