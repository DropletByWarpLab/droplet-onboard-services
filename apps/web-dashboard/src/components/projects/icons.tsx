// Lucide icon map for the Projects surface. Keeps the design's terse `name`
// ergonomics (`<PmIcon name="plus" />`) while rendering real lucide-react glyphs
// at the dashboard's standard stroke.

import {
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
  type LucideIcon,
} from "lucide-react";

import type { JSX } from "react";

export const ICONS: Record<string, LucideIcon> = {
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
