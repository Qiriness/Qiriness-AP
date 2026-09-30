/** Agent Setup screens. Keys are prefixed `setup.`. */
import { en as e_tabs, fr as f_tabs } from "./setup-tabs";
import { en as e_lists, fr as f_lists } from "./setup-lists";
import { en as e_knowledge, fr as f_knowledge } from "./setup-knowledge";
import { en as e_forwarding, fr as f_forwarding } from "./setup-forwarding";
import { en as e_rules, fr as f_rules } from "./setup-rules";
import { en as e_test, fr as f_test } from "./setup-test";

export const en = { ...e_tabs, ...e_lists, ...e_knowledge, ...e_forwarding, ...e_rules, ...e_test } as const;

export const fr: Record<keyof typeof en, string> = { ...f_tabs, ...f_lists, ...f_knowledge, ...f_forwarding, ...f_rules, ...f_test };
