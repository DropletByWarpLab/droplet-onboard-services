"use client";

/**
 * WARP-2976 — the viewer's nav gates, resolved exactly as the Sidebar and the
 * Workspace shell resolve them (same four hooks, same `medicalConnector`
 * derivation), so a department home's quick links and the Customize
 * checklist can never offer a destination the nav itself would hide.
 */
import { isMedicalConnector } from "@/components/integrations/provider-descriptors";
import type { AuthRole, NavCapabilities } from "@/components/nav-config";
import { useAuth } from "@/lib/auth";
import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { useIntegrations } from "@/lib/hooks/useIntegrations";
import { useModuleGate } from "@/lib/hooks/useModuleGate";

export interface NavGates {
  role: AuthRole | undefined;
  capabilities: NavCapabilities;
  isModuleOn: (moduleId: string) => boolean;
}

export function useNavGates(): NavGates {
  const { user } = useAuth();
  const adminCapabilities = useCapabilities();
  const isModuleOn = useModuleGate();
  const role = user?.role as AuthRole | undefined;
  const { connected } = useIntegrations(role === "owner" || role === "admin");
  return {
    role,
    capabilities: {
      ...adminCapabilities,
      medicalConnector: connected.some((e) => isMedicalConnector(e.meta.id)),
    },
    isModuleOn,
  };
}
