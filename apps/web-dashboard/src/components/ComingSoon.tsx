import type { LucideIcon } from "lucide-react";

type Props = {
  icon: LucideIcon;
  title: string;
  description: string;
  // WARP ticket id (e.g. "WARP-247") to surface as the trackable reference.
  ticket?: string;
  // What feature unlocks this page.
  unlockedBy?: string;
};

export function ComingSoon({
  icon: Icon,
  title,
  description,
  ticket,
  unlockedBy,
}: Props) {
  return (
    <div className="dp-coming-soon">
      <div className="ring">
        <Icon size={26} strokeWidth={1.5} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {(ticket || unlockedBy) && (
        <div
          style={{
            marginTop: 4,
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            justifyContent: "center",
            fontSize: 11,
            color: "var(--rd-text-3)",
          }}
        >
          {unlockedBy && (
            <span>
              Unlocked by <strong>{unlockedBy}</strong>
            </span>
          )}
          {ticket && (
            <>
              {unlockedBy && <span aria-hidden>·</span>}
              <span>
                Tracked in <code>{ticket}</code>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
