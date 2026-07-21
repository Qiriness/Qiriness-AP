/**
 * A single coherent icon set — 24×24 grid, 1.5px stroke, round joins.
 * Kept in one file so the whole app shares one visual style (no mixed sets).
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 20, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3.5 10.5 12 4l8.5 6.5" />
    <path d="M5.5 9.5V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" />
    <path d="M10 20v-5h4v5" />
  </Base>
);

export const ChatIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5v-3.5H5.5A1.5 1.5 0 0 1 4 14.5Z" />
  </Base>
);

export const InsightsIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 20V4" />
    <path d="M4 20h16" />
    <path d="M8 20v-6" />
    <path d="M13 20V9" />
    <path d="M18 20v-9" />
  </Base>
);

export const KnowledgeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 4.5h9a2 2 0 0 1 2 2V20l-3.5-2-3.5 2V6.5a2 2 0 0 0-2-2Z" />
    <path d="M16 6.5h2.5a1 1 0 0 1 1 1V20l-3.5-2" />
  </Base>
);

export const AgentIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="4.5" y="7.5" width="15" height="11" rx="2.5" />
    <path d="M12 4.5v3" />
    <circle cx="9.5" cy="13" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="13" r="1.1" fill="currentColor" stroke="none" />
    <path d="M3 12v3M21 12v3" />
  </Base>
);

export const SettingsIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.1a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-2.9-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.1-2.9H4a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.1-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.1V4a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9Z" />
  </Base>
);

export const SearchIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.4-3.4" />
  </Base>
);

export const PlusIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m9 6 6 6-6 6" />
  </Base>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m6 9 6 6 6-6" />
  </Base>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m15 6-6 6 6 6" />
  </Base>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 12h15" />
    <path d="m13 6 6 6-6 6" />
  </Base>
);

export const CheckCircleIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12 2.4 2.4 4.6-4.8" />
  </Base>
);

export const ClockIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Base>
);

export const AlertIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4.5 21 19.5H3Z" />
    <path d="M12 10v4" />
    <circle cx="12" cy="16.8" r="0.4" fill="currentColor" stroke="currentColor" />
  </Base>
);

export const DotIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
  </Base>
);

export const SparkleIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4.5c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5Z" />
    <path d="M18.5 13.5c.3 1.5.7 1.9 2.2 2.2-1.5.3-1.9.7-2.2 2.2-.3-1.5-.7-1.9-2.2-2.2 1.5-.3 1.9-.7 2.2-2.2Z" />
  </Base>
);

export const PageIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M6.5 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19V5A1.5 1.5 0 0 1 6.5 3.5Z" />
    <path d="M13 3.5V8h4.5" />
  </Base>
);

export const ExternalLinkIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 5h5v5" />
    <path d="M19 5 11 13" />
    <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-9A1.5 1.5 0 0 1 6 18.5v-9A1.5 1.5 0 0 1 7.5 8H12" />
  </Base>
);

export const RefreshIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M19 12a7 7 0 1 1-2-4.9" />
    <path d="M19 4.5V8h-3.5" />
  </Base>
);

export const StoreIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 9.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    <path d="M4 5h16l1 4a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0Z" />
    <path d="M10 20v-4.5h4V20" />
  </Base>
);

export const HelpIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.5a2.4 2.4 0 0 1 4.6.9c0 1.6-2.2 1.9-2.2 3.3" />
    <circle cx="12" cy="16.8" r="0.4" fill="currentColor" stroke="currentColor" />
  </Base>
);

export const BoldIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7Z" />
    <path d="M7 12h6.5a3.5 3.5 0 0 1 0 7H7Z" />
  </Base>
);

export const ItalicIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 5h7M7 19h7M14 5 10 19" />
  </Base>
);

export const UnderlineIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 5v6a5 5 0 0 0 10 0V5" />
    <path d="M6 20h12" />
  </Base>
);

export const ListIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 7h10M9 12h10M9 17h10" />
    <circle cx="5" cy="7" r="0.6" fill="currentColor" />
    <circle cx="5" cy="12" r="0.6" fill="currentColor" />
    <circle cx="5" cy="17" r="0.6" fill="currentColor" />
  </Base>
);

export const OrderedListIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 7h9M10 12h9M10 17h9" />
    <path d="M4 6.5 5.2 6v3M4 15h1.8l-1.8 2h2" />
  </Base>
);

export const LinkIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 14a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11 8" />
    <path d="M14 10a3.5 3.5 0 0 0-5 0l-2.5 2.5a3.5 3.5 0 0 0 5 5L13 16" />
  </Base>
);

export const CollapseIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m13 6-6 6 6 6" />
    <path d="M18 6v12" />
  </Base>
);
