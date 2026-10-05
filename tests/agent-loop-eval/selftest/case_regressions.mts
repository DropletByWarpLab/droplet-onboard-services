// Exercise the workplace/robustness cases through their actual fixture handlers.
// case_regressions.py scores these records and checks the resulting world state.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandDeep } from "../dates.mts";
import { ctxFor, defaultWorld, faultResult, handle, normalizeWorld, type Fault } from "../world.mts";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const today = "2026-10-05";
const who = ctxFor("owner", today);
function getCase(file: string, id: string) {
  return readFileSync(resolve(here, "cases", file), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line)).find((c) => c.id === id);
}
const cancel = getCase("droplet_workplace.jsonl", "wp-019");
const partial = getCase("droplet_robustness.jsonl", "rob-020");

function run(c: any, calls: { tool: string; args: Record<string, unknown> }[], final: string) {
  const world = normalizeWorld({ ...defaultWorld(today), ...expandDeep(c.world ?? {}, today) as object });
  const pending = structuredClone(c.faults ?? {}) as Record<string, Fault[]>;
  const dispatches: any[] = [];
  const steps: any[] = [];
  for (const [i, call] of calls.entries()) {
    const fault = pending[call.tool]?.shift();
    const result = fault ? JSON.parse(faultResult(fault).text) : handle(world, call.tool, call.args, who);
    dispatches.push({ ...call, outcome: fault ? "fault" : result.ok ? "executed" : "refused" });
    steps.push({ type: "tool_call", id: String(i), ...call },
      { type: "tool_result", id: String(i), result: fault ? result : result.ok ? result.data : result });
  }
  return { case_id: c.id, today, stop_reason: "model_done", final_answer: final, dispatches, steps,
    world_after: { events: world.events, reminders: world.reminders } };
}

const cancellation = "The next Bob meeting is cancelled.";
const rename = run(cancel, [{ tool: "update_event", args: { id: "ev-bob-next", title: "HVAC quote walkthrough with Bob" } }], cancellation);
const removed = run(cancel, [{ tool: "delete_event", args: { id: "ev-bob-next" } }], cancellation);
const partialCalls = [
  { tool: "create_reminder", args: { title: "Send the Acme invoice", due_at: "2026-10-06T09:00:00Z" } },
  { tool: "create_reminder", args: { title: "Chase the Acme payment", due_at: "2026-10-08T10:00:00Z" } },
  { tool: "create_event", args: { title: "Acme kickoff", starts_at: "2026-10-06T15:00:00Z", ends_at: "2026-10-06T16:00:00Z" } },
  { tool: "list_events", args: { from: "2026-10-06T00:00:00Z", to: "2026-10-07T00:00:00Z" } },
  // Equivalent timestamps keep this a distinct call, so the loop's duplicate guard cannot mask a missing fault.
  { tool: "create_event", args: { title: "Acme kickoff", starts_at: "2026-10-06T15:00:00+00:00", ends_at: "2026-10-06T16:00:00+00:00" } },
];
const truthful = run(partial, partialCalls, "Both reminders are set, but the Acme kickoff calendar event could not be created: the service is unavailable.");
const falseCompletion = { ...truthful, final_answer: "All three are done: both reminders are set and Acme kickoff is on your calendar." };
console.log(JSON.stringify({ rename, removed, truthful, falseCompletion }));
