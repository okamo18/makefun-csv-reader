// Fast drop-in replacement for csv-reader 1.0.0: run(input) returns exactly the same
// {columns, rows, errors} for every input, but reads with slice-based scanning instead of
// one character at a time. The reading policy (broken-row rules, error codes and their
// order, line counting) is csv-reader 1.0.0's, followed step for step.

const COMMA_END = 0;
const BREAK_END = 1;
const EOF_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break, dropping a
  // CR that is not followed by LF (stray_cr). Returns {value, ended, added}; `added` counts
  // the characters this call kept (beyond the prefix it was handed).
  function scanUnquoted(value) {
    const prefixLen = value.length;
    let segStart = pos;
    let parts = null;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) { // ,
        value = parts ? parts.join('') + text.slice(segStart, pos) : value + text.slice(segStart, pos);
        pos += 1;
        return { value, ended: COMMA_END, added: value.length - prefixLen };
      }
      if (c === 10) { // \n
        value = parts ? parts.join('') + text.slice(segStart, pos) : value + text.slice(segStart, pos);
        pos += 1;
        line += 1;
        return { value, ended: BREAK_END, added: value.length - prefixLen };
      }
      if (c === 13) { // \r
        if (text.charCodeAt(pos + 1) === 10) {
          value = parts ? parts.join('') + text.slice(segStart, pos) : value + text.slice(segStart, pos);
          pos += 2;
          line += 1;
          return { value, ended: BREAK_END, added: value.length - prefixLen };
        }
        // Stray CR: close the current segment, drop the CR, keep scanning.
        if (!parts) parts = [value];
        parts.push(text.slice(segStart, pos));
        value = '';
        pushError('stray_cr');
        pos += 1;
        segStart = pos;
        continue;
      }
      pos += 1;
    }
    value = parts ? parts.join('') + text.slice(segStart, pos) : value + text.slice(segStart, pos);
    return { value, ended: EOF_END, added: value.length - prefixLen };
  }

  // One segment of quoted text, text[from..to): counts its line breaks into `lines` and
  // returns its value with each CRLF or lone CR read as LF. `hasCr` is precomputed by the
  // caller; without a CR the segment is its own value.
  function quotedSegment(from, to, hasCr, state) {
    if (!hasCr) {
      // Count LFs by hopping between them.
      let i = from;
      while (true) {
        const j = text.indexOf('\n', i);
        if (j === -1 || j >= to) break;
        state.lines += 1;
        i = j + 1;
      }
      return text.slice(from, to);
    }
    let out = '';
    let seg = from;
    let i = from;
    while (i < to) {
      const c = text.charCodeAt(i);
      if (c === 13) {
        out += text.slice(seg, i) + '\n';
        state.lines += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        seg = i;
        continue;
      }
      if (c === 10) state.lines += 1;
      i += 1;
    }
    return out + text.slice(seg, to);
  }

  // Reads a quoted field whose opening quote is at pos.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let scanPos = pos + 1;
    let segStart = scanPos;
    let parts = null;
    let value = '';
    const state = { lines: 0 };
    while (true) {
      const q = text.indexOf('"', scanPos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is
        // read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        return scanUnquoted('"');
      }
      const seg = text.slice(segStart, q);
      const hasCr = seg.indexOf('\r') !== -1;
      const segValue = hasCr || (parts && parts.length) ? quotedSegment(segStart, q, hasCr, state) : seg;
      if (!hasCr && !parts) {
        // Fast path so far: no doubled quote met yet and this segment needs no rewrite.
        // Still count its LFs.
        let i = segStart;
        while (true) {
          const j = text.indexOf('\n', i);
          if (j === -1 || j >= q) break;
          state.lines += 1;
          i = j + 1;
        }
        value = segValue;
      } else {
        if (!parts) parts = [value];
        parts.push(segValue);
      }
      if (text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one literal quote, keep scanning.
        if (!parts) parts = [value];
        parts.push('"');
        value = '';
        scanPos = q + 2;
        segStart = scanPos;
        continue;
      }
      // Closing quote.
      if (parts) value = parts.join('');
      line += state.lines;
      pos = q + 1;
      break;
    }
    if (pos >= len) return { value, ended: EOF_END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA_END };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: BREAK_END };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: BREAK_END };
    }
    // What follows the closing quote is appended as it stands, up to the next comma or
    // line break.
    const junk = scanUnquoted(value);
    if (junk.added > 0) pushError('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? scanQuoted() : scanUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA_END);

    // A line that held only stray CRs is left with no characters: no record (its
    // stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
