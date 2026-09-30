/** Tickets + Conversations screens: placeholder, filled per file group in messages/tickets-*.ts. */
import { en as view, fr as viewFr } from "./tickets-view";
import { en as panels, fr as panelsFr } from "./tickets-panels";
import { en as dialogs, fr as dialogsFr } from "./tickets-dialogs";

export const en = { ...view, ...panels, ...dialogs } as const;

export const fr: Record<keyof typeof en, string> = { ...viewFr, ...panelsFr, ...dialogsFr };
