// Lucide icon map for the Projects surface. Keeps the design's terse `name`
// ergonomics (`<PmIcon name="plus" />`) while rendering real lucide-react glyphs
// at the dashboard's standard stroke.

import {
  Archive,
  ArchiveRestore,
  Plus,
  RefreshCw,
  MessageSquare,
  Eye,
  Pencil,
  Check,
  Signal,
  AlertTriangle,
  Minus,
  ChevronDown,
  ChevronLeft,
  Clock,
  GitBranch,
  User,
  Users,
  Inbox,
  Filter,
  X,
  Search,
  Link2,
  MoreHorizontal,
  Send,
  Flag,
  Calendar,
  CircleDot,
  Trash2,
  Lightbulb,
  FileText,
  Shield,
  Sparkles,
  Server,
  Columns3,
  List,
  Target,
  Layers,
  Building2,
  Briefcase,
  Handshake,
  ChartColumn,
  ChartGantt,
  type LucideIcon,
} from "lucide-react";

import type { JSX } from "react";

export const ICONS: Record<string, LucideIcon> = {
  archive: Archive,
  restore: ArchiveRestore,
  plus: Plus,
  refresh: RefreshCw,
  msg: MessageSquare,
  eye: Eye,
  pencil: Pencil,
  check: Check,
  signal: Signal,
  alert: AlertTriangle,
  minus: Minus,
  chevD: ChevronDown,
  chevL: ChevronLeft,
  clock: Clock,
  branch: GitBranch,
  user: User,
  users: Users,
  inbox: Inbox,
  filter: Filter,
  x: X,
  search: Search,
  link: Link2,
  more: MoreHorizontal,
  send: Send,
  flag: Flag,
  cal: Calendar,
  dotCircle: CircleDot,
  trash: Trash2,
  bulb: Lightbulb,
  doc: FileText,
  shield: Shield,
  spark: Sparkles,
  server: Server,
  board: Columns3,
  list: List,
  target: Target,
  layers: Layers,
  // WARP-2545 — the CRM sub-tabs and cards reuse this map so the two
  // surfaces on the Projects page draw from one icon vocabulary.
  building: Building2,
  briefcase: Briefcase,
  handshake: Handshake,
  // WARP-3524 — the Insights tab.
  chart: ChartColumn,
  // WARP-3523 — the Timeline view tab.
  gantt: ChartGantt,
};

export function PmIcon({
  name,
  size = 16,
  sw = 1.6,
  className,
  style,
}: {
  name: string;
  size?: number;
  sw?: number;
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element | null {
  const Glyph = ICONS[name] ?? Inbox;
  return <Glyph size={size} strokeWidth={sw} className={className} style={style} aria-hidden />;
}
