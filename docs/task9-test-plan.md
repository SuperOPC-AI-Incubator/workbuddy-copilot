# Task 9 test plan — mentor delivery visibility and domain packs

## Test scenarios

| Area               | Scenario                                                                   | Expected                                                                                   |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Delivery status    | Pending, fetched, acknowledged, and web-seen timestamps                    | Exact Chinese labels compose without one channel hiding another                            |
| Delivery status    | Missing legacy row and malformed/out-of-order state                        | Never claims a false delivery; legacy and uncertain states are explicit                    |
| Pending summary    | Mixed mentor messages                                                      | Only a parseable acknowledgement at/after the last fetch removes pending status            |
| Student web view   | Current mentor items visible by at least 50%                               | Calls `mark_mentor_messages_web_seen` once while the tab is visible; never acknowledges    |
| Student web view   | Mentor actor, other session, or non-mentor items                           | Does not mark any message as web-seen                                                      |
| Mentor send        | Active completed mentor/team-admin                                         | Server derives the bearer actor and creates one atomic timeline + delivery result          |
| Mentor send        | Disabled, password-change-required, student, spoofed fields, malformed RPC | Fails closed with no browser insert, trusted author override, or partial result            |
| Realtime fallback  | Error/timeout/closed                                                       | Starts one visible-tab poll loop at 5 → 10 → 20 → 30 seconds                               |
| Realtime recovery  | `SUBSCRIBED`, hidden tab, and unmount                                      | Clears timers immediately and never leaves duplicate polling behind                        |
| Domain pack        | Default, industrial override, unknown value                                | Learning-camp context is the safe default; industrial PLC content is opt-in                |
| AI availability    | Missing DeepSeek key                                                       | AI draft reports unavailable while manual mentor delivery remains independent              |
| AI provider        | Provider returns a malicious body or throws                                | Stable domain code and safe Chinese response; body/URL/key never reaches UI/logs           |
| AI persistence     | Reply or diagnosis insert fails                                            | Atomic RPC rolls both rows back and never returns `ok`                                     |
| AI persistence     | Student actor does not own the session                                     | Service-only RPC rejects the write without trusting client identity                        |
| Student composer   | AI unavailable, persistence failure, or unexpected exception               | Original/current edited input remains untouched; only known safe UI messages display       |
| Privacy            | Timeline/delivery DTO and client bundle                                    | No token, hash, service key, internal auth metadata, or raw gateway errors                 |
| Public copy        | Default static intro                                                       | Learning-camp copy with AI described as optional; no industrial-domain drift               |
| Web visibility     | Hidden/offscreen mentor cards, then visible ≥50%                           | Marks web-seen only after real visibility, once; mentor role never marks                   |
| Realtime gap       | Snapshot completes before subscribe confirmation                           | `SUBSCRIBED` invalidates old work and immediately refreshes authoritative state            |
| Snapshot           | Timeline plus optional delivery                                            | One service-only RPC/left join request; malformed joined DTO fails closed                  |
| Refresh retry      | Initial/subscribed/event snapshot fails while Realtime remains connected   | Retries at 5 → 10 → 20 → 30-second capped delays until one authoritative snapshot succeeds |
| Refresh ordering   | Session generation changes while an older snapshot is pending              | Old work cannot apply; one queued snapshot loads for the current generation                |
| Refresh coalescing | Many Realtime events or a disconnect poll arrive during one snapshot       | At most one load runs; all requests coalesce into one immediate follow-up snapshot         |
| Poll concurrency   | Repeated errors/visibility changes while a poll is pending                 | At most one poll; recovery invalidates it and its `finally` cannot restart timers          |
| Poll reconnect     | Error → pending poll → subscribed → error before old poll completes        | Old result stays invalid, but completion schedules the new disconnect at 5-second backoff  |
| Realtime event     | Timeline/delivery event while an older snapshot is pending                 | Event queues one full follow-up snapshot; complete history wins without concurrent loads   |
| Draft submission   | Double-click, edit during send, old success/failure                        | Single-flight; only unchanged successful draft clears; failures never overwrite            |
| AI draft version   | Edit, manual send, or session switch while AI draft is pending             | Late AI draft is discarded and never overwrites current input/session                      |
| AI draft failure   | Draft provider/server request rejects                                      | Current input remains untouched and the existing safe failure path handles the error       |
| AI timeout         | Provider never resolves                                                    | 20-second abort, timer cleanup, stable safe provider error                                 |

## Commands

- Focused RED/GREEN: `bun run test -- tests/unit/timeline-delivery.test.ts tests/unit/mentor-message-create.test.ts tests/unit/ai-response-create.test.ts tests/unit/ai-safety.test.ts tests/unit/ai-user-messages.test.ts tests/unit/realtime-polling.test.ts tests/unit/domain-packs.test.ts tests/unit/delivery-ui-contracts.test.ts tests/unit/web-seen-visibility.test.ts tests/unit/timeline-refresh.test.ts tests/unit/timeline-view.test.ts tests/unit/draft-submission.test.ts tests/unit/draft-composition.test.ts`
- Full unit/integration/static gate: `bun run test`
- Type, lint, format, and bundle boundary: `bun run check`
- Database behavior: `supabase test db` when Supabase CLI and PostgreSQL are available

## Negative controls

- Reintroduce `.from("timeline_items").insert` in `sendMentor`: the direct-insert contract fails.
- Accept `authorId`, `authorUsername`, or `studentId` in the server-function input: the trust-boundary contract fails.
- Remove the mentor delivery trigger or split delivery creation from the RPC transaction: the atomicity contract fails.
- Set `acknowledged_at` while marking `web_seen_at`: the web-seen contract fails.
- Keep the polling timer after `SUBSCRIBED`: the fake-clock recovery test fails.
- Put PLC language back in the default pack: the default-domain drift test fails.
- Return provider response bodies or arbitrary `error.message`: the AI safety contract fails.
- Persist reply and diagnosis in separate browser writes: the atomic persistence contract fails.
- Clear the student composer after any non-`ok` AI result: the input-preservation contract fails.
- Put PLC/industrial/DeepSeek-required copy back in `public/`: the public-copy contract fails.
- Mark a hidden or offscreen card as seen: the injected observer test fails.
- Remove the post-`SUBSCRIBED` authoritative refresh or generation guard: the gap test fails.
- Split timeline/delivery into two requests: the single-call gateway contract fails.
- Let a poll overlap or reschedule after recovery: the deferred fake-clock test fails.
- Let an old poll `finally` swallow a second disconnect after recovery: the reconnect-race test fails.
- Remove the connected-state snapshot retry: the failed-event fake-clock test fails.
- Allow event, subscribe, and polling requests to overlap: the single-flight/coalescing tests fail.
- Apply a Realtime row locally instead of loading a queued joined snapshot: the full-history event test fails.
- Clear a draft before success or after the user edited it: the submission-controller test fails.
- Apply a late AI draft after edit, manual send, or session switch: the compose-revision test fails.
- Change or clear input on AI draft failure: the compose-revision failure test fails.
- Remove provider abort/timeout cleanup: the never-resolving fetch test fails.
