/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A failure on the generator's side, not about anything that was asked for.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE sometimes fails a job it accepted with "internal error, please try again later."
 * (failCode 500). That is not about the request: on 22–23 October 2026 three Kling 3.0
 * videos failed that way within sixteen minutes, and the identical request — same images,
 * same prompt, same 10 seconds — succeeded when it was sent again the next day.
 *
 * The person used to be shown KIE's own words ("This could not be generated: internal
 * error, please try again later."), which reads like something they did. They are told
 * instead that it went wrong on our side, that nothing was charged (a failed job is
 * refunded when the server records the failure), and that they can try again. The job is
 * not retried for them: during an outage a second try fails too, and only makes them wait
 * longer for the same answer.
 *
 * Plain JavaScript, no platform APIs, so it is tested on its own (transient.test.js).
 */

/** KIE's wording for a failure on its side, as opposed to one about the request. */
const TRANSIENT = /internal error|try again later|temporar(il)?y|service (is )?(busy|unavailable|overloaded)|timed? ?out/i

/** @param {unknown} reason  a job's failMsg */
export function isTransientFailure(reason) {
  return TRANSIENT.test(String(reason ?? ''))
}

/** What the person reads when the generator failed the job on its side. */
export const TRANSIENT_FAILURE_MESSAGE =
  'Something went wrong on our end and this could not be generated. You have not been charged. Please try again.'

/**
 * A failed job's reason as the person should read it, wherever a failure is shown (the
 * generating screen, the Queue, a job that finished after the screen stopped watching).
 *
 * @param {unknown} failMsg   the reason the generator gave, if any
 * @param {string} fallback   what to say when it gave none
 */
export function failureMessage(failMsg, fallback) {
  if (isTransientFailure(failMsg)) return TRANSIENT_FAILURE_MESSAGE
  return (typeof failMsg === 'string' && failMsg.trim()) || fallback
}
