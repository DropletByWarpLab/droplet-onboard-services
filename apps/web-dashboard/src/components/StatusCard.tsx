interface StatusCardProps {
  title: string;
  value: string;
  subtitle?: string;
  status?: "ok" | "warning" | "error" | "offline";
}

const statusColors = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  offline: "bg-slate-600",
};

export function StatusCard({ title, value, subtitle, status }: StatusCardProps) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-slate-400">{title}</h3>
        {status && (
          <span className={`w-2.5 h-2.5 rounded-full ${statusColors[status]}`} />
        )}
      </div>
      <p className="text-xl font-semibold text-slate-100">{value}</p>
      {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
    </div>
  );
}
