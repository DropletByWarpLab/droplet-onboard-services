/**
 * Service desk (ADR-069, WS-12) — the one module the route layer imports.
 *
 * Re-exports the whole service surface so `routes/support/*` depends on a single
 * path (and its tests can mock exactly one module). The implementation lives in
 * the files named below; nothing here has logic of its own.
 */
export { createDesk, getDesk, listDesks, updateDesk } from "./desk.service.js";
export {
  createTicket,
  getTicket,
  listRequesterTickets,
  listTickets,
  queueCounts,
  updateTicket,
} from "./ticket.service.js";
export { addNote, addReply, getConversation, EMPTY_BODY } from "./conversation.service.js";
export { escalateTicket } from "./escalation.service.js";
export {
  SupportContactExistsError,
  createRequesterContact,
  listAgents,
  searchRequesterContacts,
  type SupportDeps,
} from "./requester.service.js";
export { INVALID_CURSOR } from "./ticket-query.js";
export { listBusinessCalendars, saveBusinessCalendar, deleteBusinessCalendar, getDeskSla, saveDeskSla,
  listMacros, saveMacro, deleteMacro, previewMacro, applyMacro } from "./sla-settings.service.js";
export { getSlaReport } from "./sla-report.service.js";
