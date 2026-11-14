const PATHS = {
  play: "M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14Z",
  pause: "M7 4h3.5v16H7zM13.5 4H17v16h-3.5z",
  next: "M5 5.5v13l9-6.5-9-6.5ZM16 5h2.5v14H16z",
  prev: "M19 5.5v13l-9-6.5 9-6.5ZM5.5 5H8v14H5.5z",
  shuffle:
    "M16 4h4v4M4 20 20 4M20 16v4h-4M14.5 14.5 20 20M4 4l5.5 5.5",
  send: "M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  plus: "M12 5v14M5 12h14",
  drag: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  back: "M15 18 9 12l6-6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  copy: "M8 8h12v12H8zM4 16V4h12",
  edit: "M4 20h4L19 9l-4-4L4 16v4Z",
  music: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  inbox: "M4 13h4l2 3h4l2-3h4M4 13l2.5-8h11l2.5 8v6H4z",
  users: "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.15a3 3 0 0 1 0 5.7",
  close: "M6 6l12 12M18 6 6 18",
} as const;

export type IconName = keyof typeof PATHS;

const FILLED: IconName[] = ["play", "pause", "next", "prev", "send"];

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const filled = FILLED.includes(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={name === "more" || name === "drag" ? 3 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
