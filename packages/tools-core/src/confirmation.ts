import type { ToolResult } from "./types.js";

export function confirmationRequired(message: string, details?: unknown): ToolResult {
  return {
    ok: false,
    status: "confirmation_required",
    error: {
      code: "CONFIRMATION_REQUIRED",
      message,
      details,
    },
  };
}

export function isConfirmationResponse(res: Response): boolean {
  return res.status === 202;
}

export async function passThroughConfirmation(res: Response): Promise<ToolResult> {
  const body = await res.json().catch(() => ({}));
  const message =
    typeof body === "object" && body && "reason" in body && typeof body.reason === "string"
      ? body.reason
      : "This action requires user confirmation in the Droplet dashboard.";
  return confirmationRequired(message, body);
}
