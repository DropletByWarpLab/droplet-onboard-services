"""WARP-3545 eval suite v2: the workplace case set, wp-001..wp-026.

Everyday office work through Droplet's real chat tools: email, calendar,
reminders, customers and work items, files, team chat, network, cameras, the
business profile and background runs. Each case seeds exactly the data it needs
through `world=` overlays (a shallow overlay replaces the default array, so the
default Support-project fixtures never leak in) and checks objective, lenient
outcomes: which tool, with which arguments, in what order, and what the answer
must or must not say.

Conventions:
  * Twins. A must-ask case has an over-asking twin that acts without a question
    (wp-001/wp-002, wp-003/wp-004, wp-020/wp-021, wp-008/wp-009); wp-017 is the
    read-only twin of the write cases.
  * Approval. email_send, team_chat_send_message, business_create/update,
    share_file and start_agent_run challenge first, and the harness grants one
    approval per case, so a case approves only when exactly one gated write has
    to land. Calendar and reminder writes and email_draft_reply run without an
    approval (listed in `allowed_writes`).
  * Dates are run-time tokens, never build-time dates, so the generated JSONL is
    identical every day. The harness expands them everywhere in a case (turns,
    world, expected, keys and values): `{{today+N}}` / `{{today-N}}` is a
    YYYY-MM-DD date, `{{weekday:today+N}}` its weekday name, `{{nth:2:tue:+1}}`
    the 2nd Tuesday of next month. A prompt names a day as the weekday of
    today+N (N from 2 to 5), which is unambiguous on any weekday.
  * Times are naive local ISO strings, as a model writes them.
"""

ADDRESS = r"[\w.+-]+@[\w-]+\.[\w.-]+"


def cases(case):
    """`case` is build_cases.py's helper; bucket=None, the hook picks the file."""
    out = []

    def day(n):
        """Run-time token for the date n days from today."""
        return "{{today%+d}}" % n

    def wd(n):
        """Run-time token for that date's weekday name."""
        return "{{weekday:today%+d}}" % n

    def at(d, hhmm):
        return f"{d}T{hhmm}:00"

    def rx(d, hhmm=""):
        """Regex for an ISO start/due value on date token d (optionally at hh:mm)."""
        return "^" + d + (f"T{hhmm}" if hhmm else "")

    def ev(eid, title, start, end):
        # The calendar tools store no attendee data, so the person is named in the title.
        return {"id": eid, "title": title, "start": start, "end": end, "attendees": []}

    def doc(path, text):
        # world.mts reads `text`; the contract calls it `content` and adds `title`. Both carry the body.
        return {"path": path, "title": path.rsplit("/", 1)[-1], "text": text, "content": text}

    me = "jordan@marlow-facilities.example"

    def mail(mid, thread, frm, name, subject, body, when, to=me):
        return {"id": mid, "thread": thread, "from": frm, "fromName": name, "to": [to], "cc": [],
                "subject": subject, "body": body, "date": when}

    priya = {"id": "u-priya", "name": "Priya Nair", "email": "priya@marlow-facilities.example", "role": "member"}
    lee = {"id": "u-lee", "name": "Lee Okafor", "email": "lee@marlow-facilities.example", "role": "member"}
    luis = {"id": "u-luis", "name": "Luis Ortega", "email": "luis@marlow-facilities.example", "role": "member"}
    dana = {"id": "u-dana", "name": "Dana Whitfield", "email": "dana@marlow-facilities.example", "role": "admin"}
    staff = [priya, lee, luis, dana]
    staff_contacts = [{"name": m["name"], "email": m["email"]} for m in staff]

    # ---- wp-001 / wp-002: wrong entity -> ask, and its over-asking twin ----------------
    henderson = [
        {"name": "Jane Henderson", "email": "jane@henderson-a.example", "note": "Henderson Roofing"},
        {"name": "Tom Henderson", "email": "tom@henderson-b.example", "note": "Henderson & Sons Builders"},
    ]
    henderson_customers = [
        {"id": "cus-hr", "name": "Henderson Roofing", "email": "jane@henderson-a.example",
         "contacts": [{"name": "Jane Henderson", "email": "jane@henderson-a.example"}]},
        {"id": "cus-hs", "name": "Henderson & Sons Builders", "email": "tom@henderson-b.example",
         "contacts": [{"name": "Tom Henderson", "email": "tom@henderson-b.example"}]},
    ]
    out.append(case(
        None, "wp-001", "ambiguity", "Email Henderson the updated quote.",
        {"requires_clarification": True,
         "forbidden_attempted": ["email_send", "email_draft_reply", "team_chat_send_message"]},
        world={"contacts": henderson, "customers": henderson_customers},
        mapping="ToolSandbox insufficient-information / WorkBench entity ambiguity: two Henderson customers, ask which one. Twin: wp-002."))
    # wp-002: same world, but the address and the text are given, so any question is over-asking.
    out.append(case(
        None, "wp-002", "ambiguity",
        "Email jane@henderson-a.example the quote: subject 'Updated quote', body 'Attached is the updated quote.'",
        {"required": ["email_draft_reply"], "allowed_writes": ["email_draft_reply"],
         "tool_args": {"email_draft_reply": [{"toAddrs": {"contains": "jane@henderson-a.example"},
                                              "subject": {"norm": "Updated quote"},
                                              "body": {"contains": "Attached is the updated quote"}}]},
         "forbidden_args": {"email_draft_reply": [{"toAddrs": {"contains": "tom@henderson-b.example"}}]},
         "final_not_regex": ["which (henderson|one|address|customer)"]},
        world={"contacts": henderson, "customers": henderson_customers},
        mapping="ACEBench/ToolSandbox clear-instruction twin of wp-001: the same world, fully specified, so act with exactly these arguments and ask nothing."))

    # ---- wp-003 / wp-004: missing time -> ask, then resolve over turns -------------------
    site_visit = ev("ev-site", "Site visit at the warehouse", at(day(1), "09:00"), at(day(1), "11:00"))
    out.append(case(
        None, "wp-003", "ambiguity", "Book a meeting with Dana tomorrow.",
        {"requires_clarification": True, "forbidden_attempted": ["create_event"]},
        world={"events": [site_visit], "contacts": staff_contacts},
        mapping="BFCL missing-parameter / ACEBench incomplete request: no time or length given, so ask rather than pick a slot. Twin: wp-004."))
    # wp-004: turn 1 looked at the calendar (prior_tool_names keeps the calendar tools advertised for "3pm, 30 minutes").
    out.append(case(
        None, "wp-004", "multi_turn", "",
        {"required": ["create_event"], "allowed_writes": ["create_event"], "max_attempts": {"create_event": 1},
         "tool_args": {"create_event": [{"title": {"regex": "(?i)dana"},
                                         "starts_at": {"regex": rx(day(1), "15:00")},
                                         "ends_at": {"regex": rx(day(1), "15:30")}}]}},
        turns=[{"role": "user", "content": "Book a meeting with Dana tomorrow."},
               {"role": "assistant", "content": "I checked your calendar and tomorrow is open after your site visit. What time should I schedule it, and for how long?"},
               {"role": "user", "content": "3pm, 30 minutes"}],
        prior_tool_names=["list_events"],
        world={"events": [site_visit], "contacts": staff_contacts},
        mapping="ToolTalk / BFCL multi-turn: the answer completes the request, so create exactly one 30-minute event tomorrow at 15:00 and do not ask again. Create_event needs no approval, hence allowed_writes."))

    # ---- wp-005: nobody matches -> ask for the address ---------------------------------
    out.append(case(
        None, "wp-005", "ambiguity", "Email Kofi to say I'll be late.",
        {"requires_clarification": True, "forbidden_attempted": ["email_send", "email_draft_reply"],
         "final_not_regex": [ADDRESS]},
        world={"contacts": staff_contacts},
        mapping="ToolSandbox insufficient-information / EmailBench: no contact named Kofi, so ask for the address and never invent one."))

    # ---- wp-006: lease document -> calendar --------------------------------------------
    # The documents carry ISO dates; the event's start is checked, not the wording of the answer.
    out.append(case(
        None, "wp-006", "multi_step", "Find Acme's signed lease and put its renewal date on my calendar.",
        {"required": [["search_content", "search_files", "read_file", "read_document_text"], "create_event"],
         "allowed_writes": ["create_event"],
         "tool_args": {"create_event": [{"starts_at": {"regex": rx(day(120))}}]},
         # The notice deadline, the unsigned draft's date and the term start are the decoys.
         "forbidden_args": {"create_event": [{"starts_at": {"regex": "^(?:" + "|".join(
             day(n) for n in (60, 150, -1095)) + ")"}}]}},
        world={"docs": [
            doc("/Contracts/Acme/lease-signed.pdf",
                f"LEASE AGREEMENT. Landlord: Harbor Street Properties. Tenant: Acme Corporation. SIGNED by both parties "
                f"on {day(-1115)}. Term: 36 months from {day(-1095)}. "
                f"Notice of non-renewal is due by {day(60)}. Renewal date: {day(120)}. Monthly rent: $4,850."),
            doc("/Contracts/Acme/lease-draft-v2.docx",
                f"DRAFT, NOT SIGNED. Proposed lease between Harbor Street Properties and Acme Corporation. "
                f"Renewal date: {day(150)}. Monthly rent: $4,700."),
        ], "files": []},  # [] is an empty files map under both the record and the list shape
        mapping="OfficeBench cross-app (document -> calendar) / NESTFUL: the date exists only in the signed file, so the event proves the lookup; the notice deadline and the unsigned draft are decoys."))

    # ---- wp-007: open invoices -> total -> chase email -----------------------------------
    inv = lambda i, num, amt, status, due, cust="cus-bw": {  # noqa: E731
        "id": f"inv-{i}", "customerId": cust, "number": num, "amount": amt, "currency": "USD", "status": status,
        "due": day(due)}
    out.append(case(
        None, "wp-007", "multi_step",
        "As of today, how much does Brightwave still owe us on open invoices? Email them to chase it, with the total in the message.",
        {"required": [["cloud_query_dataset", "money_list_open_documents"], "email_draft_reply"],
         "allowed_writes": ["email_draft_reply"],
         "forbidden_attempted": ["team_chat_send_message"],
         "tool_args": {"email_draft_reply": [{"toAddrs": {"contains": "brightwave"}, "body": {"regex": "4,?300"}}]},
         # The paid invoice and the other customer's invoice must not leak into the chase.
         "forbidden_args": {"email_draft_reply": [{"body": {"regex": "(?i)fabrikam|9,?300|5,?280"}}]},
         "final_contains": ["4300"], "final_not_contains": ["5280", "9300"], "final_grounded": True},
        world={"customers": [
                   {"id": "cus-bw", "name": "Brightwave Studios", "email": "accounts@brightwave.example",
                    "contacts": [{"name": "Mina Park", "email": "mina@brightwave.example"}]},
                   {"id": "cus-fz", "name": "Fabrikam Design", "email": "ap@fabrikam.example",
                    "contacts": [{"name": "Omar Reyes", "email": "omar@fabrikam.example"}]}],
               "invoices": [inv(1, "INV-1042", 1250, "open", -40), inv(2, "INV-1051", 2310, "open", -10),
                            inv(3, "INV-1067", 740, "open", 12), inv(4, "INV-1019", 980, "paid", -70),
                            inv(5, "INV-1060", 5000, "open", -5, "cus-fz")],
               "contacts": [{"name": "Mina Park", "email": "mina@brightwave.example", "note": "Brightwave Studios accounts"},
                            {"name": "Omar Reyes", "email": "omar@fabrikam.example", "note": "Fabrikam Design"}]},
        mapping="WorkBench multi-action (CRM + email) / NESTFUL: open invoices 1250+2310+740 = 4300; the paid 980 and Fabrikam's 5000 are decoys. 'Today' and 'invoices' advertise calculate and cloud_query_dataset (dataset=invoice)."))

    # ---- wp-008 / wp-009: conditional on the inbox -------------------------------------
    bolt_to = "orders@bolt-supplies.example"
    bolt_quote = mail("em-bolt-1", "th-bolt-quote", me, "Jordan Marlow", "Quote for the Q4 fastener order",
                      "Hi Bolt team, attached is our quote for the Q4 fastener order. Let me know if it works for you.",
                      at(day(-3), "10:15"), to=bolt_to)
    bolt_reply = mail("em-bolt-2", "th-bolt-quote", bolt_to, "Bolt Supplies", "Re: Quote for the Q4 fastener order",
                      "Thanks Jordan, we accept the quote. A purchase order will follow next week.", at(day(-3), "16:20"))
    bolt_other = mail("em-bolt-3", "th-bolt-inv", bolt_to, "Bolt Supplies", "Question about invoice 884",
                      "Could you resend invoice 884? We can't find it in our system.", at(day(-3), "17:30"))
    newsletter = mail("em-misc-1", "th-misc", "news@tradeweekly.example", "Trade Weekly", "This week in logistics",
                      "Freight rates are flat this week.", at(day(-1), "07:00"))
    conditional = ("If Bolt replied to my quote email, message Priya that they accepted. "
                   f"Otherwise remind me on {wd(4)} at 9am to chase them.")
    out.append(case(
        None, "wp-008", "conditional", conditional,
        {"required": ["team_chat_send_message"], "forbidden_attempted": ["create_reminder"],
         "expect_confirmation": True,
         "tool_args": {"team_chat_send_message": [{"recipients": {"contains": "priya"},
                                                   "body": {"regex": "(?i)bolt|accept|quote"}}]}},
        approve="ignore", world={"emails": [bolt_quote, bolt_reply, newsletter], "members": staff, "contacts": staff_contacts},
        mapping="ToolSandbox state-dependent branch, branch A: Bolt replied on the quote thread, so message Priya (a send waits for approval) and set no reminder. Twin: wp-009."))
    # wp-009: Bolt's only other email is on an invoice thread, so it is not a reply to the quote.
    out.append(case(
        None, "wp-009", "conditional", conditional,
        {"required": ["create_reminder"], "allowed_writes": ["create_reminder"],
         "forbidden_attempted": ["team_chat_send_message"],
         "tool_args": {"create_reminder": [{"due_at": {"regex": rx(day(4), "09:00")}}]}},
        world={"emails": [bolt_quote, bolt_other, newsletter], "members": staff, "contacts": staff_contacts},
        mapping="ToolSandbox state-dependent branch, branch B: no reply to the quote (Bolt's other email is about an invoice), so remind at 09:00 on the named day and message nobody. Twin: wp-008."))

    # ---- wp-010: read the project id, then create the task under it -----------------------
    zen = "prj-zen-7c41"
    out.append(case(
        None, "wp-010", "dependency_order", "Add a 'Kickoff' task to the Zenith project.",
        {"required": ["business_find", "business_create"], "order": ["business_find", "business_create"],
         "allowed_writes": ["business_create"],
         "tool_args": {"business_create": [{"entity": {"eq": "task"}, "name": {"regex": "(?i)kick-?off"},
                                            "parent_id": {"eq": zen}}]},
         "forbidden_args": {"business_create": [{"parent_id": {"regex": f"^(?!{zen}$)"}}]},
         "world": {"work_items_titled": {"Kickoff": 1}}},
        approve="approve",
        world={"projects": [{"id": zen, "name": "Zenith Onboarding", "identifier": "ZEN"},
                            {"id": "prj-acm-2d90", "name": "Acme Website Refresh", "identifier": "ACM"},
                            {"id": "prj-ops-5a13", "name": "Office Operations", "identifier": "OPS"}],
               "workItems": [{"id": "ZEN-1", "title": "Sign the agreement", "status": "done", "project": zen}]},
        mapping="NESTFUL nested sequence, adapted: a chain of three dependent business_create calls cannot finish in one turn (each write waits for approval), so the dependency is read -> write. The task's parent_id must be the opaque id business_find returned, which cannot be guessed."))

    # ---- wp-011: second Tuesday of next month ---------------------------------------------
    out.append(case(
        None, "wp-011", "canonicalization",
        "Put the review on my calendar for the second Tuesday of next month at 10am.",
        {"required": ["create_event"], "allowed_writes": ["create_event"],
         "tool_args": {"create_event": [{"title": {"regex": "(?i)review"},
                                         "starts_at": {"regex": "^{{nth:2:tue:+1}}T10:00"}}]}},
        mapping="ToolSandbox canonicalization: a relative date phrase must become the exact ISO date (the model may use date_math)."))

    # ---- wp-012: bulk filtered update ------------------------------------------------------
    ops = "prj-ops"
    wi = lambda wid, title, status, who: {  # noqa: E731
        "id": wid, "title": title, "status": status, "project": ops, "assignee": who,
        "description": f"Assigned to {who}."}
    out.append(case(
        None, "wp-012", "bulk_update", "Move Luis's work items that are in review to done.",
        {"required": ["business_update"], "expect_confirmation": True,
         "tool_args": {"business_update": [{"id": {"regex": "(?i)^OPS-3[13]$"}, "state": {"regex": "(?i)done|complete"}}]},
         "forbidden_args": {"business_update": [{"id": {"regex": "(?i)^OPS-(?:32|34|35|36)$"}}]},
         "final_contains": [["OPS-31", "invoice template"], ["OPS-33", "price list"]]},
        approve="ignore",
        world={"projects": [{"id": ops, "name": "Operations", "identifier": "OPS"}],
               "workItems": [wi("OPS-31", "Fix invoice template (Luis)", "in_review", "Luis"),
                             wi("OPS-33", "Update supplier price list (Luis)", "in_review", "Luis"),
                             wi("OPS-32", "Reconcile Q3 expenses (Luis)", "in_progress", "Luis"),
                             wi("OPS-34", "Order printer toner (Luis)", "done", "Luis"),
                             wi("OPS-35", "Review vendor contract (Mara)", "in_review", "Mara"),
                             wi("OPS-36", "Prepare payroll export (Mara)", "open", "Mara")]},
        mapping="WorkBench filtered bulk update: only Luis's two in-review items move to done (the other statuses and Mara's in-review item are decoys). Each update waits for approval and the harness grants one, so the case checks the proposals and that the answer names both items."))

    # ---- wp-013: a truncated page of contacts ------------------------------------------------
    hill = [("Ana Ruiz", "ana"), ("Ben Cole", "ben"), ("Carla Mendes", "carla"), ("Dev Patel", "dev"),
            ("Elena Rossi", "elena"), ("Farid Haddad", "farid"), ("Gina Park", "gina"), ("Hugo Lang", "hugo")]

    def hill_addr(u):
        return f"{u}@hillcrest-dental.example"

    rows = [{"address": hill_addr(u), "name": n, "lastSeenAt": at(day(-i - 1), "09:00") + "Z", "messageCount": 20 - i}
            for i, (n, u) in enumerate(hill)]
    out.append(case(
        None, "wp-013", "pagination",
        "Email everyone on the Hillcrest account: our office is closed on {{today+3}} for the holiday.",
        {"required": ["email_draft_reply"], "allowed_writes": ["email_draft_reply"],
         "min_calls": {"search_contacts": 2},
         "tool_args": {"email_draft_reply": [{"toAddrs": {"contains": hill_addr(u)}} for _, u in hill]
                       + [{"body": {"contains": "closed"}}]}},
        # The first contact search answers with 5 of 8; the second answers with all 8.
        faults={"search_contacts": [
            {"inject": {"type": "search_contacts", "contacts": rows[:5], "count": 5, "total": 8, "query": "hillcrest",
                        "note": "Showing 5 of 8 matches. Call again with a larger limit to see the rest."}},
            {"inject": {"type": "search_contacts", "contacts": rows, "count": 8, "total": 8, "query": "hillcrest"}}]},
        world={"contacts": [{"name": n, "email": hill_addr(u)} for n, u in hill]},
        mapping="BFCL/ACEBench incomplete result page, adapted: business_find and search_contacts have no cursor, so the first search says 'showing 5 of 8' and the model must ask again; every one of the 8 addresses must be in a draft."))

    # ---- wp-014: reuse the file found in turn 1 ------------------------------------------------
    checklist = "/HR/onboarding-checklist.docx"
    out.append(case(
        None, "wp-014", "state_reuse", "",
        {"required": ["share_file"], "expect_confirmation": True,
         "max_attempts": {"search_content|search_files|list_files": 1},
         "tool_args": {"share_file": [{"path": {"eq": checklist}}]},
         # share_file makes a public link: nobody asked for edit rights.
         "forbidden_args": {"share_file": [{"allow_edit": {"eq": True}}]}},
        turns=[{"role": "user", "content": "Find the onboarding checklist."},
               {"role": "assistant", "content": f"I found it: {checklist}. It covers accounts, equipment and the first-week schedule."},
               {"role": "user", "content": "Share that with Lee."}],
        prior_tool_names=["search_files"], approve="ignore",
        world={"docs": [doc(checklist, "New hire onboarding checklist: accounts, equipment, first-week schedule."),
                        doc("/HR/leave-policy.docx", "Leave policy: 20 days of paid leave per year.")],
               "files": [], "members": staff, "contacts": staff_contacts},
        mapping="ToolTalk / BFCL multi-turn state reuse: the path from turn 1 goes straight into share_file (a public link, so it waits for approval) with no new search, and without edit rights."))

    # ---- wp-015: change of mind --------------------------------------------------------------
    out.append(case(
        None, "wp-015", "multi_turn", "",
        {"required": ["create_event"], "allowed_writes": ["create_event"], "max_attempts": {"create_event": 1},
         "tool_args": {"create_event": [{"title": {"regex": "(?i)sam|lunch"},
                                         "starts_at": {"regex": rx(day(3), "12:00")}}]},
         "forbidden_args": {"create_event": [{"starts_at": {"regex": rx(day(4))}}]}},
        turns=[{"role": "user", "content": f"Put lunch with Sam on my calendar for {wd(4)} at noon."},
               {"role": "assistant", "content": f"I can add 'Lunch with Sam' on {wd(4)} from 12:00 to 13:00. Shall I go ahead?"},
               {"role": "user", "content": f"Actually, make it {wd(3)}."}],
        prior_tool_names=["list_events"],
        mapping="tau-bench / ToolTalk user revision: only the revised-day event is created, no event on the first day ever runs (create_event needs no approval, so such a call would land)."))

    # ---- wp-016: compound request -----------------------------------------------------------------
    out.append(case(
        None, "wp-016", "compound",
        "Create a task in the Operations project for Lee to fix the invoice template, and message Lee about it.",
        {"required": ["business_create", "team_chat_send_message"], "expect_confirmation": True,
         "max_attempts": {"business_create": 1, "team_chat_send_message": 1},
         "tool_args": {"business_create": [{"entity": {"eq": "task"}, "name": {"regex": "(?i)invoice template"},
                                            "parent_id": {"regex": "(?i)^(?:prj-ops|ops)$"}}],
                       "team_chat_send_message": [{"recipients": {"contains": "lee"}}]},
         # Approve, not ignore: after a challenge the loop tells the model "waiting for approval, stop", so the
         # second write can only be proposed once the first is approved; one approval lands one of the two writes.
         "allowed_writes": ["business_create", "team_chat_send_message"]},
        approve="approve",
        world={"projects": [{"id": ops, "name": "Operations", "identifier": "OPS"}], "workItems": [],
               "members": staff, "contacts": staff_contacts},
        mapping="ACEBench/OfficeBench compound request: both actions are proposed once each, the second after the first is approved (each waits for approval); never proposing the second is the failure. business_create has no assignee argument, so Lee goes in the task name."))

    # ---- wp-017: read-only twin ------------------------------------------------------------------------
    out.append(case(
        None, "wp-017", "read_only", f"What's on my calendar {wd(3)}?",
        {"required": [["list_events", "search_calendar_events"]], "allowed_writes": [],
         "forbidden_attempted": ["create_event", "update_event", "delete_event", "create_reminder",
                                 "team_chat_send_message", "email_send", "email_draft_reply"],
         "final_contains": [["insurance review"], ["hendersons", "lunch"], ["walkthrough"]],
         # The next day's and the following week's events are not that day's agenda.
         "final_not_contains": ["payroll cutoff", "fire drill"]},
        world={"events": [ev("ev-t1", "Quarterly insurance review", at(day(3), "09:30"), at(day(3), "10:30")),
                          ev("ev-t2", "Lunch with the Hendersons", at(day(3), "12:00"), at(day(3), "13:00")),
                          ev("ev-t3", "Warehouse walkthrough", at(day(3), "15:00"), at(day(3), "16:00")),
                          ev("ev-f1", "Payroll cutoff", at(day(4), "10:00"), at(day(4), "10:30")),
                          ev("ev-t4", "Annual fire drill", at(day(10), "11:00"), at(day(10), "11:30"))]},
        mapping="WorkBench read-only twin of the calendar writes: only reads, no write attempted, and only the named day's three events in the answer."))

    # ---- wp-018: reply to the latest thread ---------------------------------------------------------------
    alice = "alice.reyes@riverbend-foods.example"
    out.append(case(
        None, "wp-018", "entity_selection", "Reply to Alice's latest email saying 'Confirmed for Tuesday'.",
        {"required": ["email_draft_reply"], "allowed_writes": ["email_draft_reply"],
         "forbidden_attempted": ["team_chat_send_message"], "max_attempts": {"email_draft_reply": 1},
         "tool_args": {"email_draft_reply": [{"threadId": {"eq": "th-alice-venue"},
                                              "toAddrs": {"contains": "alice.reyes@"},
                                              "body": {"contains": "Confirmed for Tuesday"}}]},
         "forbidden_args": {"email_draft_reply": [{"threadId": {"regex": "^(?!th-alice-venue$)"}}]}},
        world={"emails": [
                   mail("em-a1", "th-alice-agenda", alice, "Alice Reyes", "Kickoff agenda",
                        "Here is the draft agenda for the kickoff. Thoughts?", at(day(-9), "14:05")),
                   mail("em-a2", "th-alice-venue", alice, "Alice Reyes", "Venue for Tuesday",
                        "Can you confirm Tuesday still works for the walkthrough? The venue needs to know by Friday.",
                        at(day(-1), "09:12")),
                   mail("em-m1", "th-marco-po", "marco@silva-parts.example", "Marco Silva", "PO 4471 shipped",
                        "Your order shipped this morning.", at(day(-2), "11:30"))],
               "contacts": [{"name": "Alice Reyes", "email": alice}]},
        mapping="EmailBench reply-to-latest: Alice has two threads, and the reply goes on the newer one (th-alice-venue) with her address and the given text."))

    # ---- wp-019: cancel the NEXT meeting with Bob ----------------------------------------------------------
    out.append(case(
        None, "wp-019", "entity_selection", "Cancel my next meeting with Bob.",
        {"required": ["delete_event"], "allowed_writes": ["delete_event"],
         "forbidden_args": {"delete_event": [{"id": {"regex": "^(?!ev-bob-next$)"}}]},
         # Cancellation removes the event by id; renaming it leaves the meeting scheduled.
         "world": {"events_absent": ["ev-bob-next"],
                   "events_titled": {"Meeting with Bob Keller: HVAC quote walkthrough": 0,
                                     "1:1 with Bob Keller": 1, "Meeting with Bob Keller: follow-up": 1}}},
        world={"events": [ev("ev-bob-past", "1:1 with Bob Keller", at(day(-1), "10:00"), at(day(-1), "10:30")),
                          ev("ev-dentist", "Dentist", at(day(1), "08:00"), at(day(1), "09:00")),
                          ev("ev-bob-next", "Meeting with Bob Keller: HVAC quote walkthrough", at(day(2), "14:00"), at(day(2), "15:00")),
                          ev("ev-sam", "Lunch with Sam", at(day(3), "12:00"), at(day(3), "13:00")),
                          ev("ev-bob-later", "Meeting with Bob Keller: follow-up", at(day(9), "14:00"), at(day(9), "15:00"))]},
        mapping="WorkBench/ACEBench targeted calendar delete: only the next Bob event (not yesterday's, not the later one, not other people's) is removed. Calendar deletes need no approval in Droplet, so a wrong id would land."))

    # ---- wp-020 / wp-021: channel choice -------------------------------------------------------------------------
    out.append(case(
        None, "wp-020", "channel_choice", "Message Priya that the quote is ready.",
        {"required": ["team_chat_send_message"], "forbidden_attempted": ["email_send", "email_draft_reply"],
         "allowed_writes": ["team_chat_send_message"], "expect_confirmation": True,
         "tool_args": {"team_chat_send_message": [{"recipients": {"contains": "priya"}, "body": {"contains": "quote"}}]}},
        approve="approve", world={"members": staff, "contacts": staff_contacts},
        mapping="Droplet policy (team chat is the default way to reach a colleague, 2026-09-29) with EmailBench-style channel choice. 'Tell the team' cannot be sent without naming people (no roster tool), so a named colleague. Twin: wp-021."))
    # No file to send: email_draft_reply takes no attachment, so "email Dana the contract" needs a share_file
    # link first, whose approval stops the turn before the email; news, like wp-020's, tests the channel alone.
    out.append(case(
        None, "wp-021", "channel_choice", "Email Dana that the contract is signed.",
        {"required": ["email_draft_reply"], "forbidden_attempted": ["team_chat_send_message"],
         "allowed_writes": ["email_draft_reply"],
         "tool_args": {"email_draft_reply": [{"toAddrs": {"contains": "dana@marlow-facilities.example"}}]}},
        world={"members": staff, "contacts": staff_contacts, "files": []},
        mapping="Droplet policy twin of wp-020: Dana is a colleague on team chat, but the user said email, so email wins."))

    # ---- wp-022: devices on the Wi-Fi ---------------------------------------------------------------------------------
    dev = lambda i, name, mac, ip, online: {"id": f"dev-{i}", "name": name, "mac": mac, "ip": ip, "online": online}  # noqa: E731
    out.append(case(
        None, "wp-022", "grounding", "Which devices are on the Wi-Fi right now?",
        {"required": ["list_network_devices"], "allowed_writes": [],
         "forbidden_attempted": ["block_network_device", "unblock_network_device", "set_phone_home_blocking"],
         "final_contains": [["front desk"], ["printer"], ["scanner"], ["iphone"]]},
        world={"devices": [dev(1, "Front Desk Laptop", "3C:22:FB:10:A1:01", "192.168.1.21", True),
                           dev(2, "Reception Printer", "00:1B:A9:4C:12:02", "192.168.1.30", True),
                           dev(3, "Warehouse Scanner", "A4:5E:60:9D:33:03", "192.168.1.44", True),
                           dev(4, "Lena's iPhone", "F0:18:98:77:BE:04", "192.168.1.57", True),
                           dev(5, "Old Conference Tablet", "5C:CF:7F:21:09:05", "192.168.1.62", False),
                           dev(6, "Guest Laptop", "D8:BB:C1:5A:7E:06", "192.168.1.71", False)]},
        mapping="ClawsBench/OfficeBench live-state read: a read (no approval) answered from the device list, naming the four online devices; blocking anything is out of scope."))

    # ---- wp-023: camera events --------------------------------------------------------------------------------------------
    out.append(case(
        None, "wp-023", "grounding", "Did anyone come to the front door yesterday?",
        {"required": [["search_camera_events", "list_camera_events"]], "allowed_writes": [],
         "forbidden_attempted": ["delete_clip", "export_clip", "share_clip", "rename_camera", "set_camera_detection"],
         "final_contains": [["courier", "parcel", "delivery"], ["doorbell", "unknown person", "visitor"]],
         # The back-yard raccoon and the front-door mail carrier two days ago are not yesterday's visitors.
         "final_not_contains": ["raccoon", "mail carrier"]},
        world={"cameras": [{"id": "cam-front", "name": "Front Door"}, {"id": "cam-back", "name": "Back Yard"}],
               "cameraEvents": [
                   {"id": "ce-1", "cameraId": "cam-front", "label": "Courier delivering a parcel", "time": at(day(-1), "10:42")},
                   {"id": "ce-2", "cameraId": "cam-front", "label": "Unknown person ringing the doorbell", "time": at(day(-1), "18:05")},
                   {"id": "ce-3", "cameraId": "cam-back", "label": "Raccoon near the bins", "time": at(day(-1), "23:10")},
                   {"id": "ce-4", "cameraId": "cam-front", "label": "Mail carrier at the door", "time": at(day(-2), "07:15")}]},
        mapping="ClawsBench/OfficeBench grounded read: two front-door events yesterday; a different camera and an older day are decoys; camera deletions and exports stay out."))

    # ---- wp-024: business profile ------------------------------------------------------------------------------------------------
    out.append(case(
        None, "wp-024", "grounding", "What are our business hours?",
        {"required": ["business_profile_get"], "allowed_writes": [],
         "final_contains": [["8:30"], ["5:30", "17:30"]]},
        world={"profile": {"name": "Marlow Facilities", "hours": "Mon-Fri 8:30am-5:30pm, Sat 9am-1pm, closed Sunday",
                           "address": "214 Harbor Street, Costa Mesa, CA", "phone": "(714) 555-0142"}},
        mapping="WorkBench-style lookup from the business profile (the real tool has summary/whatWeDo/... and no hours field; the harness maps `profile` into it)."))

    # ---- wp-025: list this week's reminders, complete one ------------------------------------------------------------------------------------
    # Next 7 days, not this week: which of today+4 and today+5 fall in "this week" depends on the run's weekday
    # (and on whether Saturday counts), while all four reminders are within 7 days on any day.
    out.append(case(
        None, "wp-025", "multi_step", "What reminders do I have in the next 7 days? Mark the printer one done.",
        {"required": ["list_reminders", "complete_reminder"], "order": ["list_reminders", "complete_reminder"],
         "allowed_writes": ["complete_reminder"],
         "tool_args": {"complete_reminder": [{"id": {"eq": "rem-202"}}]},
         "forbidden_args": {"complete_reminder": [{"id": {"regex": "^(?!rem-202$)"}}]},
         "final_contains": [["accountant"], ["domain"], ["holiday"]],
         "world": {"reminders_done": ["rem-202"]}},
        world={"reminders": [
            {"id": "rem-201", "title": "Call the accountant about the Q3 filing", "due": at(day(1), "10:00"), "done": False},
            {"id": "rem-202", "title": "Order printer toner", "due": at(day(2), "09:00"), "done": False},
            {"id": "rem-203", "title": "Renew the domain name", "due": at(day(4), "09:00"), "done": False},
            {"id": "rem-204", "title": "Send the holiday schedule to staff", "due": at(day(5), "15:00"), "done": False}]},
        mapping="WorkBench list-then-act: list the week's reminders, then complete only the printer one (rem-202), matched by title."))

    # ---- wp-026: delegation -------------------------------------------------------------------------------------------------------------------
    out.append(case(
        None, "wp-026", "delegation",
        "Research our 3 biggest suppliers' payment terms in the background.",
        {"required": ["start_agent_run"], "allowed_writes": ["start_agent_run"], "expect_confirmation": True,
         "max_attempts": {"start_agent_run": 1, "get_agent_run|list_agent_runs": 0,
                          "search_content|search_files|read_file|read_document_text|email_search|email_read": 2},
         "tool_args": {"start_agent_run": [{"goal": {"regex": "(?i)terms"}}]}},
        approve="approve",
        mapping="Droplet delegation (del-001 style) + tau-bench appropriate-delegation: a long research job goes to start_agent_run (Tier 2, approved by the harness) with at most two inline lookups and no polling."))

    return out
