/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What a file really is, from its first bytes.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The content type of an upload is whatever the uploader said. Moderation must
 * not trust it: an HTML file declared as `video/mp4`, or a video declared as an
 * image, is exactly what someone probing the checker would send. The container
 * handed to ffmpeg and the type sent to the classifier both come from here.
 *
 * ── Audio is recognised too, and for a reason ───────────────────────────────
 *
 * There is no classifier for audio, so audio is the one kind that is let through
 * unchecked. That made "this is audio" a way round the check for anything else:
 * the upload endpoint used to take the client's word for it (an `uploadPath` of
 * `audio/…`, or a `data:audio/…` header), and an explicit image sent that way went
 * to KIE unread. Whether something is audio is therefore decided here, from its
 * bytes, and a file that is an image or a video is checked whatever it was
 * called.
 *
 * Only the types the app stores (s3.js ALLOWED_CONTENT_TYPES) are recognised;
 * anything else is `null`, which callers treat as "cannot be checked".
 */

const ascii = (buf, from, to) => buf.subarray(from, to).toString('latin1')

/**
 * @param {Buffer} head  at least the first 16 bytes of the file
 * @returns {{kind: 'image'|'video'|'audio', contentType: string} | null}
 */
export function sniffMedia(head) {
  if (!head || head.length < 12) return null

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', contentType: 'image/jpeg' }
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'image', contentType: 'image/png' }
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return { kind: 'image', contentType: 'image/webp' }
  if (ascii(head, 0, 3) === 'GIF') return { kind: 'image', contentType: 'image/gif' }

  // Audio: WAV, an MP3 (an ID3 tag, or a bare MPEG frame), and an .m4a. Checked after the
  // images so a JPEG's own FF D8 can never be mistaken for the MPEG frame sync (FF E0 and up).
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return { kind: 'audio', contentType: 'audio/wav' }
  if (ascii(head, 0, 3) === 'ID3') return { kind: 'audio', contentType: 'audio/mpeg' }
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return { kind: 'audio', contentType: 'audio/mpeg' }

  // ISO base media (MP4, MOV, M4A): a box whose type sits at offset 4. `ftyp` first is
  // the norm; older QuickTime files may open with another box. An audio-only file says
  // so in its brand ("M4A "), and is not a video no matter how it is labelled.
  const box = ascii(head, 4, 8)
  if (box === 'ftyp') {
    const brand = ascii(head, 8, 12)
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return { kind: 'audio', contentType: 'audio/mp4' }
    return { kind: 'video', contentType: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4' }
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return { kind: 'video', contentType: 'video/quicktime' }

  // Matroska / WebM: the EBML magic number.
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { kind: 'video', contentType: 'video/webm' }
  }

  return null
}
