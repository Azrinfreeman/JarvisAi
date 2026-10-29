# Voice participant continuity — implementation proposal

Date: 28 October 2026 (MYT).

Status: approved by the owner with “proceed” and implemented for RainBot 0.3.2. TypeScript and 231 automated tests passed, including participant continuity during processing/queued delivery, rapid rejoining, speaker retention, revoked access, withdrawal, and session-replacement races. The sections below retain the approved design. See `PROJECT_STATE.md` for final packaging verification and delivery details. Real Discord reception during participant churn still needs the user-side pilot; no production recording or restart was initiated during implementation.

## Intended behavior

With **Server beta testers already consented** selected, ordinary joins and leaves should update the listening participants automatically. Capture, the rolling audio buffer, and an already requested transcript or summary continue without requiring `/voice-summary stop` and `/voice-summary start`.

Remove the automatic public message shown in the screenshot:

> Participants changed. Use /voice-summary stop, then /voice-summary start to announce a new listening session.

This means applying the configured server-consent policy to new participants. It does not grant Discord roles, change channel permission overwrites, or give participants permission to control the bot or request AI results.

Individual-consent mode keeps its explicit opt-in requirements. This proposal does not add automatic transcript posting; results remain available through the existing commands and mentions.

## Confirmed cause

- `VoiceCapture.membership()` in `src/voice-summary/capture.ts` calls `pause()` on every membership change, including server-consent sessions.
- `pause()` clears the buffer, changes the session revision, destroys all receive streams, and emits `invalidated`.
- `VoiceSummaryService` in `src/voice-summary/service.ts` aborts its current job on `invalidated`; delivery also rejects a changed buffer epoch.
- `VoiceCommands.voiceState()` in `src/voice-summary/discord.ts` posts the participant-change message. Failure to send that notice currently stops the session too.
- Request delivery currently requires the requester to remain in voice. Merely preserving the buffer would therefore still cancel some results when the requester leaves.

The change must address capture, result authorization, and chat notification together.

## 1. Update participants without resetting server-consent capture

Separate ordinary participant updates from session invalidation.

For an active server-consent session in the same configured guild and voice channel:

- Compute added and removed human member IDs. Ignore bots and unchanged member sets.
- Subscribe to newly joined members under the existing server-consent setting. Capture only packets received after they join; never invent earlier coverage for their speech.
- Remove subscriptions for members who leave. Preserve their previously captured audio until it expires from the existing five-minute rolling buffer or is explicitly cleared.
- Keep the existing buffer, session epoch, coverage start, transcription cache, and in-progress request snapshot.
- Avoid voice reconnects or self-deafen changes for ordinary joins and leaves.
- Detach stream callbacks before intentional stream destruction. An expected removal must not trigger the generic stream-end/error handler and pause everyone.
- Bind packet callbacks to the current session and subscription identity. Late packets from removed or replaced subscriptions must be ignored, including rapid leave/rejoin events.
- Release removed stream references promptly; retain existing packet, byte, snapshot, and participant limits.

Membership changes during initial voice-readiness setup must reconcile against the latest member set before capture becomes active. Stop, withdrawal, or session replacement during that await must still prevent late activation. Do not create competing setup operations.

If everyone leaves while the bot's connection remains healthy, retain the active session in an idle condition with no human receive subscriptions. Existing audio expires normally; new arrivals can resume reception under the same server-consent policy. A healthy empty interval is silence, not proof of a connection failure. Actual disconnects still invalidate the session.

More than ten simultaneous human participants, receive/decryption failures, or resource limits remain reasons to pause rather than capture a silently incomplete participant set.

## 2. Let requested results finish across ordinary joins and leaves

- Continue processing the immutable audio snapshot selected when the request was accepted. New arrivals do not extend or restart that request's time window.
- Do not emit session invalidation or abort the job solely because the participant list changed in server-consent mode.
- Preserve earlier speech from departed participants in that snapshot, under the consent policy active when it was captured. Leaving voice is distinct from `/voice-summary withdraw`.
- Preserve bounded speaker labels for speakers retained in the rolling buffer, including speakers who left before a new request. Avoid losing names merely because they are absent from the current voice-member list; prune metadata when no buffer or active snapshot needs it.
- Require requesters to be in the listening channel when submitting a request, as today.
- For delivery, revalidate the original guild and original destination channel, current requester guild membership and AI access, requester visibility of that destination, and the bot's required channel/attachment permissions. A requester leaving or moving voice alone must not cancel an accepted request if those access checks still pass.
- Never redirect an accepted result to the requester's new voice channel.
- Keep fresh permission checks and cancellation signals immediately before each Discord send, including sends queued in REST.

Keep the current one-job limit, cooldown, deadlines, duplicate suppression, memory cleanup, cloud allowance checks, and no automatic paid retry behavior.

## 3. Remove participant-change chat spam

For ordinary joins and leaves in server-consent mode:

- Do not send a public message, create a replacement notice, or edit the original notice for each change.
- Update participant counts and listening state through the existing desktop/dashboard status and `/voice-summary status`.
- Keep the initial listening announcement and explicit start/stop/withdrawal feedback. The initial notice should explain briefly that server-consent listening continues as participants join or leave.
- Keep actual failure feedback available through status and the private command response. Suppressing routine membership notices must not suppress a real error.

Existing messages already posted in Discord remain in place. This change prevents future participant-change notices; it does not bulk-delete chat history.

## 4. Events that still invalidate work

These continue to clear pending audio/results and prevent stale delivery:

- Explicit `/voice-summary stop` or `/voice-summary withdraw`.
- Bot shutdown, replacement of the listening session, or a bot move/disconnect/deafening that interrupts capture.
- Loss of required access or permissions, including a requester losing authorization to receive an accepted result.
- Receive/decryption failure, invalid packet/timing state, or exceeded resource limits.
- Individual-consent membership changes, which still require fresh opt-in before further capture.

Routine member changes must not automatically restart a session paused for any of these reasons. New arrivals also must not override an earlier withdrawal or explicit stop.

## Files expected to change after approval

| File | Change |
| --- | --- |
| `src/voice-summary/capture.ts` | Separate participant reconciliation from invalidation; manage subscriptions and startup races. |
| `src/voice-summary/discord.ts` | Quiet routine updates, preserve initial notice, and separate request submission checks from delivery checks. |
| `src/voice-summary/service.ts` | Preserve job/cache validity across membership-only updates; adjust snapshot speaker metadata integration if needed. |
| `src/voice-summary/buffer.ts` | Only if needed to expose retained speaker IDs for bounded label cleanup. |
| `tests/voice-summary-core.test.ts` | Capture, buffer continuity, job completion, and subscription lifecycle regressions. |
| `tests/voice-summary-discord.test.ts` | Quiet joins/leaves, original-channel delivery, authorization, and cancellation races. |
| `README.md`, `WINDOWS_APP.md`, `PROJECT_STATE.md` | Document the final behavior and validation. |

No new dependency or settings toggle is expected. The existing consent mode selects the behavior.

## Verification after implementation

1. Join/leave during listening preserves epoch and accumulated coverage; new-member packets are captured, removed subscriptions cannot contribute late packets, and departed speech remains within retention limits.
2. Join/leave during transcription, summarization, and queued delivery does not cancel a valid server-consent request. Verify both a different participant and the requester leaving voice.
3. Removed subscriptions ending or erroring during cleanup do not pause remaining participants. Rapid leave/rejoin does not duplicate streams or accept stale frames.
4. Membership churn during initial readiness uses the latest members; stop/withdrawal during that await cannot enable reception afterward.
5. Normal joins/leaves produce no public participant-change messages. Status counts stay accurate; unchanged voice-state events do nothing.
6. Empty-channel idle behavior, re-entry, rolling retention, speaker metadata cleanup, and the ten-participant limit remain bounded and predictable.
7. Stop/withdrawal, permission revocation, disconnect, and session replacement still cancel stale output, including REST-queued attachments. Individual consent remains enforced.
8. Run focused voice tests, `npm run check`, and the full regression suite. If distributing an installer, rebuild and run the existing packaged checks before delivery.
9. Perform a user-side Discord pilot: start listening, speak, have someone join and leave while a summary processes, and verify one result appears in the original voice channel without participant-change spam. Keep actual reception/recognition claims limited to what this pilot verifies.

## Delivery boundary

After approval, implement and verify the changes first. A running installed desktop build will need the updated package and a restart to use new code; source edits alone do not update that installation. No recording, production restart, installer installation, or old-message deletion is performed as part of this planning-only request.
