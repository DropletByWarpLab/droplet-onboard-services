"use client";

import { useAuth } from "@/lib/auth";
import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { useIntegrations } from "@/lib/hooks/useIntegrations";
import { useModuleGate } from "@/lib/hooks/useModuleGate";
import { isMedicalConnector } from "@/components/integrations/provider-descriptors";
import type { AuthRole, NavCapabilities } from "@/components/nav-config";

/**
 * The three inputs every nav-config gate reads — role, capabilities, module
 * switches — resolved for the signed-in viewer.
 *
 * Lifted out of Sidebar.tsx (WARP-3116) because the chat's page list
 * (`assistantPages`) must gate on exactly what the sidebar gates on; two
 * copies of the `medicalConnector` derivation would be two answers to "can
 * this person see /practice".
 */
export function useNavGates(): {
  role: AuthRole | undefined;
  capabilities: NavCapabilities;
  isModuleOn: (moduleId: string) => boolean;
} {
  const { user } = useAuth();
  const adminCapabilities = useCapabilities();
  const isModuleOn = useModuleGate();
  // WARP-2880: /practice is advertised only while a medical integration is
  // connected. Fetched for owner/admin only — the route 403s everyone else,
  // and Practice is role-hidden from them anyway.
  const role = user?.role as AuthRole | undefined;
  const { connected } = useIntegrations(role === "owner" || role === "admin");
  const capabilities = {
    ...adminCapabilities,
    medicalConnector: connected.some((e) => isMedicalConnector(e.meta.id)),
  };
  return { role, capabilities, isModuleOn };
}
