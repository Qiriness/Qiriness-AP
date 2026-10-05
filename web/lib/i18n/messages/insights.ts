/** Insights screens. Keys are prefixed `insights.`. */
import { en as e_kit, fr as f_kit } from "./insights-kit";
import { en as e_shell, fr as f_shell } from "./insights-shell";
import { en as e_overview, fr as f_overview } from "./insights-overview";
import { en as e_sales, fr as f_sales } from "./insights-sales";
import { en as e_marketing, fr as f_marketing } from "./insights-marketing";
import { en as e_fulfilment, fr as f_fulfilment } from "./insights-fulfilment";
import { en as e_support, fr as f_support } from "./insights-support";
import { en as e_customers, fr as f_customers } from "./insights-customers";
import { en as e_agent, fr as f_agent } from "./insights-agent";
import { en as e_charts, fr as f_charts } from "./insights-charts";
import { en as e_social, fr as f_social } from "./insights-social";

export const en = { ...e_kit, ...e_shell, ...e_overview, ...e_sales, ...e_marketing, ...e_fulfilment, ...e_support, ...e_customers, ...e_agent, ...e_charts, ...e_social } as const;

export const fr: Record<keyof typeof en, string> = { ...f_kit, ...f_shell, ...f_overview, ...f_sales, ...f_marketing, ...f_fulfilment, ...f_support, ...f_customers, ...f_agent, ...f_charts, ...f_social };
