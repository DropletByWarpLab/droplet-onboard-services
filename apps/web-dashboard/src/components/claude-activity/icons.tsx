/**
 * WARP-279 — Icon re-exports for the dashboard.
 *
 * Keeping a thin re-export so widgets can `import { ... } from "./icons"`
 * without each component owning its own lucide-react import block. Some
 * names rebound to better fit the dashboard's visual language (e.g.
 * `GitBranch` → `Branch`).
 */

export {
  Activity,
  AlertCircle as ShieldAlert,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  Clock,
  Code,
  ExternalLink,
  GitBranch as Branch,
  GitCommit,
  GitPullRequest,
  Hash as Ticket,
  Hourglass,
  ListChecks,
  Loader2,
  MinusCircle,
  PlayCircle,
  ScrollText,
  Sparkles,
  StickyNote,
  XCircle,
} from "lucide-react";
