import type { SVGProps } from "react";

/**
 * A small hand-drawn icon set.
 *
 * HeroUI ships only status icons, and pulling in a whole icon library for
 * fourteen glyphs is not worth the weight. These are all built the same way —
 * 24×24 box, 1.75 stroke, round caps and joins, no fills — so the sidebar reads
 * as one family rather than the pile of mismatched symbols it used to be.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const DashboardIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="4.5" rx="1.5" />
    <rect x="13.5" y="10.5" width="7.5" height="10.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </Icon>
);

export const InboxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12h4.5l1.5 3h6l1.5-3H21" />
    <path d="M5.2 5.5 3 12v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6l-2.2-6.5A2 2 0 0 0 16.9 4H7.1a2 2 0 0 0-1.9 1.5Z" />
  </Icon>
);

export const CalendarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Icon>
);

export const ComposeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Icon>
);

export const ChatIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
  </Icon>
);

export const MemoryIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 19.5V6a2 2 0 0 1 2-2h13v16H6.5A2.5 2.5 0 0 0 4 22.5" />
    <path d="M8 8h7M8 12h7" />
  </Icon>
);

export const AutonomyIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v18M3 7h18" />
    <path d="M6.5 7 4 13h5ZM17.5 7 15 13h5Z" />
    <path d="M4 13a2.5 2.5 0 0 0 5 0M15 13a2.5 2.5 0 0 0 5 0" />
  </Icon>
);

export const TeamIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.5A6 6 0 0 1 21 20" />
  </Icon>
);

export const LabIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 3v6.5L4.6 18a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 9.5V3" />
    <path d="M8.5 3h7M7 15h10" />
  </Icon>
);

export const AuditIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 5h11M9 12h11M9 19h11" />
    <path d="M4 5h.01M4 12h.01M4 19h.01" />
  </Icon>
);

export const PomeloIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="13.5" r="7.5" />
    <path d="M12 6c0-1.5.8-2.6 2.5-3M12 6c-.6-1-1.6-1.5-3-1.5" />
  </Icon>
);

export const AccountsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 13.5a4 4 0 0 0 5.7.4l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
    <path d="M14 10.5a4 4 0 0 0-5.7-.4l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.6-1.6" />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </Icon>
);

export const SidebarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9.5 4v16" />
  </Icon>
);

export const ForwardIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5.5 12 12l-8 6.5ZM13 5.5 21 12l-8 6.5Z" />
  </Icon>
);

/**
 * The brand mark — deliberately not built on `Icon`.
 *
 * It used to be: a stroked arc, a stem and a zigzag, drawn with the same 1.6px
 * line as the nav glyphs. That is why it read as a fifteenth utility icon
 * rather than a logo. A mark has a different job — it has to be recognisable at
 * 18px in a browser tab, survive being reversed, and work in one colour — and
 * that job wants a solid shape, not a line drawing.
 *
 * So: a solid Z, and the badge it sits in supplies the disc. Drawing the disc
 * into the mark as well was the first attempt, and inside a 40px tile it
 * produced three alternating bands — accent ring, dark disc, accent counter —
 * where the ring carried no meaning and only muddied the shape. The container
 * already is the circle; the mark only has to be the letter.
 *
 * Citrus is carried by the accent the whole product is painted in, not by the
 * glyph. A stem drawn on top — tried, variant 5d — reads as charm at 88px and
 * as a smudge at 18.
 */
export const ZestMark = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...p}>
    <path fill="currentColor" d="M5.6 5h12.8v2.9L9.9 18.1h8.5V21H5.6v-2.9L14.1 7.9H5.6V5Z" />
  </svg>
);

export const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const MoonIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </Icon>
);

export const MonitorIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const ChevronUpDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m8 9.5 4-4 4 4M8 14.5l4 4 4-4" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4.5 12.5 5 5 10-11" />
  </Icon>
);

export const SignOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 8.5 6.5 12l3.5 3.5M6.5 12H16" />
  </Icon>
);

/**
 * The same doorway, walked the other way. Only the arrow is mirrored — a CSS
 * flip of the whole glyph would move the door to the other side, and then the
 * pair no longer reads as one door with two directions.
 */
export const SignInIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M12.5 8.5 16 12l-3.5 3.5M16 12H6.5" />
  </Icon>
);

export const PlansIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5h10M4 10h7M4 15h12" />
    <circle cx="18" cy="5" r="1.6" />
    <circle cx="15" cy="10" r="1.6" />
  </Icon>
);
