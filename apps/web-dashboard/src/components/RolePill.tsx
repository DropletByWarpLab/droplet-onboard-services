import type { DisplayRole } from "@/lib/profileMode";

const LABEL: Record<DisplayRole, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  member: "Member",
  viewer: "Viewer",
  family: "Family",
  guest: "Guest",
};

export function RolePill({ role }: { role: DisplayRole }) {
  return (
    <span className="dp-role-pill" data-role={role}>
      <span className="swatch" aria-hidden />
      {LABEL[role]}
    </span>
  );
}
