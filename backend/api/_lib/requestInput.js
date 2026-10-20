/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What a request may contain — checked once, at the door.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The body parsers have run; no handler has. Three things are settled here, for every route at once,
 * wherever they appear — in a JSON body at any depth (keys included) or in a query string:
 *
 *   • A NUL character (\u0000) is refused with a 400. PostgreSQL cannot store one in text and answers with
 *     an error; a request carrying one used to travel all the way to the database and come back as a 500
 *     — "the server is broken" for what is plainly a bad request, and a line in the error log each time.
 *     Nothing this app accepts has any use for one.
 *
 *   • A body nested deeper than any real request, or with more parts than one, is refused with a 400.
 *     Walking it would be work for no one, and serialising it again later is how a stack overflows.
 *
 *   • Half of an emoji — a lone surrogate like \ud800, which JSON allows and no text has — is mended into
 *     the replacement character (U+FFFD). A text column does that quietly on its own, but a jsonb column
 *     refuses it with an error, which came back as a 500 for a document (a studio setting, a wardrobe
 *     slot) that someone had every right to save. Mending it here makes every column behave alike, and
 *     leaves nothing for a route added tomorrow to forget.
 */

const MAX_NODES = 100_000
const MAX_DEPTH = 100

/** @returns {'nul' | 'too-complex' | null} */
export function inspect(root) {
  const todo = [[root, 0]]
  let nodes = 0
  while (todo.length) {
    const [value, depth] = todo.pop()
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return 'too-complex'
    if (typeof value === 'string') {
      if (value.includes('\u0000')) return 'nul'
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key.includes('\u0000')) return 'nul'
        todo.push([inner, depth + 1])
      }
    }
  }
  return null
}

const mended = text => (text.isWellFormed() ? text : text.toWellFormed())

/**
 * Replace every lone surrogate, in place, in the strings and the keys of a parsed JSON document.
 * (The document is this request's own copy. Entries are written with defineProperty because a
 * parsed `{"__proto__": …}` is an ordinary key, and assigning to it would set a prototype instead.)
 */
export function mendSurrogates(root) {
  const todo = [root]
  while (todo.length) {
    const node = todo.pop()
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        if (typeof item === 'string') node[i] = mended(item)
        else if (item && typeof item === 'object') todo.push(item)
      })
      continue
    }
    for (const [key, value] of Object.entries(node)) {
      const newKey = mended(key)
      const newValue = typeof value === 'string' ? mended(value) : value
      if (newKey !== key || newValue !== value) {
        if (newKey !== key) delete node[key]
        Object.defineProperty(node, newKey, { value: newValue, writable: true, enumerable: true, configurable: true })
      }
      if (newValue && typeof newValue === 'object') todo.push(newValue)
    }
  }
}

/** Express middleware: put it after the body parsers. */
export function guardRequestInput(req, res, next) {
  const found = inspect(req.query) || inspect(req.body)
  if (found === 'nul') {
    return res.status(400).json({ error: 'The request contains a character that is not allowed.', code: 'BAD_CHARACTER' })
  }
  if (found === 'too-complex') {
    return res.status(400).json({ error: 'The request is too complicated to read.', code: 'BAD_REQUEST' })
  }
  if (req.body && typeof req.body === 'object') mendSurrogates(req.body)
  next()
}
