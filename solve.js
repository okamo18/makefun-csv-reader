// Fast drop-in replacement for csv-reader 1.0.0: run(input) returns exactly the same
// {columns, rows, errors} for every input. The reading policy (broken-row rules, error
// codes and their order, line counting) is csv-reader 1.0.0's, followed step for step;
// the speed comes from slice-based scanning with indexOf jumps between delimiters
// instead of one character at a time.

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

  // The last field read, set by the scan functions (avoids an allocation per field).
  let fValue = '';
  let fEnded = EOF_END;

  // Delimiter caches: the index of the next ',', '\n' and '\r' at or after the point
  // they were computed from, or -1 when none remains. pos only moves forward, so a
  // cached index behind pos is refreshed and one ahead of pos stays exact.
  let nComma = text.indexOf(',', 0);
  let nNl = text.indexOf('\n', 0);
  let nCr = text.indexOf('\r', 0);

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `prefix` up to the next comma or line break,
  // dropping a CR that is not followed by LF (stray_cr). Sets fValue and fEnded;
  // returns how many characters this call kept beyond the prefix.
  function scanUnquoted(prefix) {
    let segStart = pos;
    let parts = null;
    let value = prefix;
    while (true) {
      if (nComma !== -1 && nComma < pos) nComma = text.indexOf(',', pos);
      if (nNl !== -1 && nNl < pos) nNl = text.indexOf('\n', pos);
      if (nCr !== -1 && nCr < pos) nCr = text.indexOf('\r', pos);
      let m = -1;
      let kind = -1;
      if (nComma !== -1) { m = nComma; kind = 0; }
      if (nNl !== -1 && (m === -1 || nNl < m)) { m = nNl; kind = 1; }
      if (nCr !== -1 && (m === -1 || nCr < m)) { m = nCr; kind = 2; }
      if (m === -1) {
        fValue = parts ? parts.join('') + text.slice(segStart, len) : value + text.slice(segStart, len);
        fEnded = EOF_END;
        pos = len;
        return fValue.length - prefix.length;
      }
      if (kind === 0) {
        fValue = parts ? parts.join('') + text.slice(segStart, m) : value + text.slice(segStart, m);
        fEnded = COMMA_END;
        pos = m + 1;
        return fValue.length - prefix.length;
      }
      if (kind === 1) {
        fValue = parts ? parts.join('') + text.slice(segStart, m) : value + text.slice(segStart, m);
        fEnded = BREAK_END;
        pos = m + 1;
        line += 1;
        return fValue.length - prefix.length;
      }
      if (text.charCodeAt(m + 1) === 10) {
        fValue = parts ? parts.join('') + text.slice(segStart, m) : value + text.slice(segStart, m);
        fEnded = BREAK_END;
        pos = m + 2;
        line += 1;
        return fValue.length - prefix.length;
      }
      // Stray CR: close the current segment, drop the CR, keep scanning.
      if (!parts) parts = [value];
      parts.push(text.slice(segStart, m));
      value = '';
      pushError('stray_cr');
      pos = m + 1;
      segStart = pos;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and fEnded.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let scanPos = pos + 1;
    let segStart = scanPos;
    let parts = null;
    let value = '';
    let qLines = 0;
    while (true) {
      const q = text.indexOf('"', scanPos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is
        // read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        scanUnquoted('"');
        return;
      }
      const crIdx = text.indexOf('\r', segStart);
      const hasCr = crIdx !== -1 && crIdx < q;
      if (!hasCr && !parts) {
        // Fast path: the whole field is one slice; count its LFs by hopping.
        let i = segStart;
        while (true) {
          const j = text.indexOf('\n', i);
          if (j === -1 || j >= q) break;
          qLines += 1;
          i = j + 1;
        }
        value = text.slice(segStart, q);
      } else {
        // General path: rewrite CRs to LFs segment by segment, counting lines.
        let segValue;
        if (!hasCr) {
          let i = segStart;
          while (true) {
            const j = text.indexOf('\n', i);
            if (j === -1 || j >= q) break;
            qLines += 1;
            i = j + 1;
          }
          segValue = text.slice(segStart, q);
        } else {
          let out = '';
          let seg = segStart;
          let i = segStart;
          while (i < q) {
            const c = text.charCodeAt(i);
            if (c === 13) {
              out += text.slice(seg, i) + '\n';
              qLines += 1;
              i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
              seg = i;
              continue;
            }
            if (c === 10) qLines += 1;
            i += 1;
          }
          segValue = out + text.slice(seg, q);
        }
        if (!parts) parts = [value];
        parts.push(segValue);
        value = '';
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
      fValue = parts ? parts.join('') : value;
      line += qLines;
      pos = q + 1;
      break;
    }
    if (pos >= len) {
      fEnded = EOF_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnded = COMMA_END;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnded = BREAK_END;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnded = BREAK_END;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma
    // or line break.
    const added = scanUnquoted(fValue);
    if (added > 0) pushError('quote_junk');
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
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) scanQuoted();
      else scanUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA_END);

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
