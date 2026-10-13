/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Frames from a video, so a video can be checked like a set of images.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The classifier reads images, not video. A few frames spread across the clip
 * catch what a person would see in it; a sub-second flash between two sampled
 * frames can be missed, which is the honest limit of sampling.
 *
 * ── Running ffmpeg on files strangers uploaded ───────────────────────────────
 *
 * ffmpeg is a large parser pointed at untrusted bytes, so it is held down:
 *
 *   • execFile with an argument array — never a shell, never string-built
 *     commands, so nothing in a filename or a request can become a command;
 *   • the container is FORCED from the declared type (`-f mov` / `-f matroska`),
 *     not guessed. Guessing lets a text file pose as a playlist (HLS) that makes
 *     ffmpeg open other files or URLs named inside it;
 *   • `-protocol_whitelist file` besides, so even a parser surprise cannot reach
 *     the network;
 *   • every call has a timeout and an output cap, and the temp directory is
 *     removed in a finally block.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** ffmpeg is not installed (or not found). A deployment problem, not a bad file. */
export class FramesUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'FramesUnavailableError'
    if (cause) this.cause = cause
  }
}

/** The file is not a video ffmpeg can read. The caller treats it as unverifiable. */
export class UnreadableMediaError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'UnreadableMediaError'
    if (cause) this.cause = cause
  }
}

/** Demuxer by declared content type — see the note above on why it is forced. */
const DEMUXERS = {
  'video/mp4': 'mov',
  'video/quicktime': 'mov',
  'video/webm': 'matroska',
}

const CALL_TIMEOUT_MS = 30_000
const FRAME_WIDTH = 512

/** Options both tools share. `-nostdin` is ffmpeg's alone; ffprobe rejects it. */
const readArgs = format => ['-v', 'error', '-f', format, '-protocol_whitelist', 'file']

async function exec(binary, args, label) {
  try {
    return await run(binary, args, { timeout: CALL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true })
  } catch (e) {
    if (e?.code === 'ENOENT') throw new FramesUnavailableError(`${label} is not installed on this server.`, e)
    throw new UnreadableMediaError(`${label} could not read this video.`, e)
  }
}

/** Seconds, or 0 when the file does not say. */
async function durationOf(file, format, cfg) {
  const { stdout } = await exec(
    cfg.ffprobePath,
    [...readArgs(format), '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    'ffprobe',
  )
  const seconds = Number.parseFloat(String(stdout).trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

/**
 * Moments to sample: the middle of each of `count` equal slices of the clip, so
 * the first and last instants (often a black frame) are not what is judged.
 *
 * @returns {number[]} seconds
 */
export function sampleTimes(duration, count) {
  if (!(duration > 0) || count <= 1) return [0]
  const last = Math.max(0, duration - 0.1)
  return Array.from({ length: count }, (_, i) => Math.min(last, (duration * (i + 0.5)) / count))
}

/**
 * Pull `count` JPEG frames out of a video file on disk.
 *
 * @param {string} file  a local path (the caller downloaded it)
 * @param {{contentType: string, count: number, config: {ffmpegPath: string, ffprobePath: string}}} opts
 * @returns {Promise<Buffer[]>} at least one frame
 * @throws {FramesUnavailableError | UnreadableMediaError}
 */
export async function extractFrames(file, { contentType, count, config }) {
  const format = DEMUXERS[contentType]
  if (!format) throw new UnreadableMediaError(`"${contentType}" is not a video type that can be checked.`)

  const duration = await durationOf(file, format, config)
  const times = sampleTimes(duration, count)

  const dir = await mkdtemp(path.join(os.tmpdir(), 'moderation-'))
  try {
    const frames = []
    for (const [i, t] of times.entries()) {
      const out = path.join(dir, `frame-${i}.jpg`)
      try {
        await exec(config.ffmpegPath, [
          ...readArgs(format), '-nostdin',
          '-y', '-ss', t.toFixed(3), '-i', file,
          '-frames:v', '1',
          '-vf', `scale=w='min(${FRAME_WIDTH},iw)':h=-2`,
          '-q:v', '5',
          out,
        ], 'ffmpeg')
        frames.push(await readFile(out))
      } catch (e) {
        // A missing binary is fatal; one unreadable instant is not, as long as
        // some other frame comes out.
        if (e instanceof FramesUnavailableError) throw e
      }
    }
    if (!frames.length) throw new UnreadableMediaError('No frame could be read from this video.')
    return frames
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
