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
 * Only the types the app stores (s3.js ALLOWED_CONTENT_TYPES) are recognised;
 * anything else is `null`, which callers treat as "cannot be checked".
 */

const ascii = (buf, from, to) => buf.subarray(from, to).toString('latin1')

/**
 * @param {Buffer} head  at least the first 16 bytes of the file
 * @returns {{kind: 'image'|'video', contentType: string} | null}
 */
export function sniffMedia(head) {
  if (!head || head.length < 12) return null

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', contentType: 'image/jpeg' }
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'image', contentType: 'image/png' }
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return { kind: 'image', contentType: 'image/webp' }
  if (ascii(head, 0, 3) === 'GIF') return { kind: 'image', contentType: 'image/gif' }

  // ISO base media (MP4, MOV): a box whose type sits at offset 4. `ftyp` first is
  // the norm; older QuickTime files may open with another box.
  const box = ascii(head, 4, 8)
  if (box === 'ftyp') {
    return { kind: 'video', contentType: ascii(head, 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4' }
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return { kind: 'video', contentType: 'video/quicktime' }

  // Matroska / WebM: the EBML magic number.
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { kind: 'video', contentType: 'video/webm' }
  }

  return null
}
