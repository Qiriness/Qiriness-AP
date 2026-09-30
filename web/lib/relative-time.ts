import { DICTIONARIES, SOURCE_DICTIONARY } from "@/lib/i18n/dictionaries";
import { makeTranslate, type Translate } from "@/lib/i18n/translate";

/** Screens not converted yet keep calling it without `t` and read English. */
const ENGLISH = makeTranslate("en", DICTIONARIES.en, SOURCE_DICTIONARY);

/** Formats an ISO timestamp as a short relative label, e.g. "2h ago" / "il y a 2 h". */
export function formatRelativeTime(iso: string | null | undefined, t: Translate = ENGLISH): string {
  if (!iso) return "";

  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec < 30) return t("time.now");
  if (diffSec < 60) return t("time.seconds", { n: diffSec });

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return t("time.minutes", { n: diffMin });

  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return t("time.hours", { n: diffHour });

  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return t("time.days", { n: diffDay });

  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return t("time.months", { n: diffMonth });

  return t("time.years", { n: Math.round(diffMonth / 12) });
}
