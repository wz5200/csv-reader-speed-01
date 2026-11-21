// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly what
// csv-reader's readCsv returns for {text, header} — {columns, rows, errors} —
// but reads the text with native indexOf scans and sliced substrings instead
// of one character at a time.
//
// The reference reads a CSV text once, left to right, with commas and double
// quotes. A U+FEFF at its very start is dropped. A record ends at LF or CRLF,
// and a line left with no characters is no record. Outside quotes a CR not
// followed by LF is dropped (error stray_cr). A field that opens with a quote
// runs to the next quote that is not doubled, "" inside it one quote and each
// CRLF or lone CR inside it read as LF; what follows its closing quote, up to
// the next comma or line break, is appended as it stands (quote_junk, when the
// field ends); a quote that never closes is a literal character, and the text
// after it is read again as unquoted (unterminated_quote). A quote inside an
// unquoted field is a literal character. Fields stay strings, never trimmed or
// converted. columns is the first record when header is true, else null; rows
// holds the records after it (every record when header is false), each padded
// with empty strings (short_row, with fields: its field count) or cut
// (long_row, with extra: the cut fields) to the first record's width. Each
// error is {code, line, row}, in the order met, a record's short_row or
// long_row when it ends: line the 1-based line its record starts on, counting
// every LF, CRLF and lone CR inside quotes, and row its record's index in
// rows, null for the header.
//
// Speed comes from never touching a character twice in the common case. The
// parser keeps, for the line it is on, the index of that line's LF and whether
// the line holds a stray CR (a CR that is not the CRLF ending the line):
// an unquoted field on a clean line ends at one indexOf(',') or at the line
// end, and its value is one substring. A quoted field's closing quote is
// found with indexOf jumps over its escapes, and its value is one substring
// unless it holds line breaks or doubled quotes. Only the broken corners (a
// lone CR inside a field, junk after a closing quote, a quote that never
// closes) take a second pass, and only over that field.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const QUOTE = 34; // "
const CR = 13; // \r
const LF = 10; // \n
const COMMA_CH = 44; // ,

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // Info about the line pos is on, cached and recomputed when pos passes it:
  // le is the index of the line's LF, or n when the text holds no more LF;
  // hasLF says le is a real LF; clean says the line holds no stray CR before
  // le (its only CR, if any, is the CRLF ending it).
  let le = -1;
  let hasLF = false;
  let clean = true;
  let lineKnown = false;
  function ensureLine() {
    if (lineKnown && pos <= le) return;
    const l = text.indexOf('\n', pos);
    if (l === -1) {
      le = n;
      hasLF = false;
    } else {
      le = l;
      hasLF = true;
    }
    const r = text.indexOf('\r', pos);
    clean = r === -1 || r >= le || (hasLF && r === le - 1);
    lineKnown = true;
  }

  // Reads an unquoted field starting at pos, onto startValue. Sets fValue to
  // the field, fEnded to how it ended, fAdded to the characters kept.
  let fValue = '';
  let fEnded = COMMA;
  let fAdded = 0;
  function readUnquoted(startValue) {
    let value = startValue;
    let added = 0;
    while (true) {
      ensureLine();
      if (!clean) {
        // A stray CR is in this line: scan for the nearest of comma, LF, CR.
        const c = text.indexOf(',', pos);
        const l = text.indexOf('\n', pos);
        const r = text.indexOf('\r', pos);
        let m = -1;
        let kind = 0;
        if (c !== -1) { m = c; kind = 0; }
        if (l !== -1 && (m === -1 || l < m)) { m = l; kind = 1; }
        if (r !== -1 && (m === -1 || r < m)) { m = r; kind = 2; }
        if (m === -1) {
          added += n - pos;
          value += text.substring(pos, n);
          pos = n;
          fEnded = END;
          break;
        }
        if (kind === 0) {
          added += m - pos;
          value += text.substring(pos, m);
          pos = m + 1;
          fEnded = COMMA;
          break;
        }
        if (kind === 1) {
          added += m - pos;
          value += text.substring(pos, m);
          pos = m + 1;
          line += 1;
          fEnded = LINE_BREAK;
          break;
        }
        if (text.charCodeAt(m + 1) === LF) {
          added += m - pos;
          value += text.substring(pos, m);
          pos = m + 2;
          line += 1;
          fEnded = LINE_BREAK;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        added += m - pos;
        value += text.substring(pos, m);
        pos = m + 1;
        continue;
      }
      // A clean line: the field ends at the next comma before the line end,
      // or at the line end (a CRLF's CR is not part of it).
      const c = text.indexOf(',', pos);
      if (c !== -1 && c < le) {
        added += c - pos;
        value += text.substring(pos, c);
        pos = c + 1;
        fEnded = COMMA;
        break;
      }
      let end = le;
      if (hasLF && le > pos && text.charCodeAt(le - 1) === CR) end = le - 1;
      added += end - pos;
      value += text.substring(pos, end);
      if (!hasLF) {
        pos = n;
        fEnded = END;
      } else {
        pos = le + 1;
        line += 1;
        fEnded = LINE_BREAK;
      }
      break;
    }
    fValue = value;
    fAdded = added;
  }

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). readUnquoted reports its stray_cr errors here.
  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended = COMMA;

    do {
      let value;
      if (text.charCodeAt(pos) === QUOTE) {
        quoted = true;
        const open = pos;
        const openLine = line;
        // Find the closing quote: the next quote that is not doubled.
        let close = -1;
        let hasEscapes = false;
        let q = pos + 1;
        while (true) {
          q = text.indexOf('"', q);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === QUOTE) {
            hasEscapes = true;
            q += 2;
            continue;
          }
          close = q;
          break;
        }
        if (close === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          readUnquoted('"');
          value = fValue;
          ended = fEnded;
          fields.push(value);
          continue;
        }
        // The field closed. Its span holds no line break and no doubled quote
        // in the common case: the value is one substring.
        const span = text.substring(open + 1, close);
        const hasBreak = span.indexOf('\n') !== -1 || span.indexOf('\r') !== -1;
        if (!hasBreak && !hasEscapes) {
          value = span;
        } else if (!hasBreak) {
          value = span.replace(/""/g, '"');
        } else {
          const breaks = span.match(/\r\n|\r|\n/g);
          if (breaks !== null) line += breaks.length;
          let v = span;
          if (span.indexOf('\r') !== -1) v = v.replace(/\r\n?/g, '\n');
          if (hasEscapes) v = v.replace(/""/g, '"');
          value = v;
        }
        const after = close + 1;
        if (after >= n) {
          pos = after;
          ended = END;
        } else {
          const c = text.charCodeAt(after);
          if (c === COMMA_CH) {
            pos = after + 1;
            ended = COMMA;
          } else if (c === LF) {
            pos = after + 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (c === CR && text.charCodeAt(after + 1) === LF) {
            pos = after + 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            // What follows the closing quote is appended as it stands, up to
            // the next comma or line break.
            pos = after;
            readUnquoted(value);
            value = fValue;
            ended = fEnded;
            if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
        }
      } else {
        quoted = false;
        // The common case, inlined: a clean line's unquoted field ends at the
        // next comma before the line end, or at the line end itself.
        ensureLine();
        if (clean) {
          const c = text.indexOf(',', pos);
          if (c !== -1 && c < le) {
            value = text.substring(pos, c);
            pos = c + 1;
            ended = COMMA;
          } else {
            let end = le;
            if (hasLF && le > pos && text.charCodeAt(le - 1) === CR) end = le - 1;
            value = text.substring(pos, end);
            if (!hasLF) {
              pos = n;
              ended = END;
            } else {
              pos = le + 1;
              line += 1;
              ended = LINE_BREAK;
            }
          }
        } else {
          readUnquoted('');
          value = fValue;
          ended = fEnded;
        }
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
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
