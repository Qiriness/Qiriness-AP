/** Orders and Settings screens. Keys are prefixed `orders.`, `settings.` and `orderEnum.`. */
import { en as e_orders, fr as f_orders } from "./pages-orders";
import { en as e_settings, fr as f_settings } from "./pages-settings";
import { en as e_home, fr as f_home } from "./pages-home";
import { en as e_login, fr as f_login } from "./pages-login";

export const en = { ...e_orders, ...e_settings, ...e_home, ...e_login } as const;

export const fr: Record<keyof typeof en, string> = { ...f_orders, ...f_settings, ...f_home, ...f_login };
