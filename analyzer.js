/*
 * Code Coach analyzer
 * Pure functions, no DOM. Works in the side panel and in Node (for tests).
 *
 * analyze(code, options) -> { language, issues[], counts{}, lines }
 * Each issue: { rule, severity, line, col, len, message, hint, answer,
 *               range:[startLine0, endLine0], originalLines[], fix|null }
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    maxLineLength: 80,
    indentStyle: 'auto', // 'auto' | 'spaces' | 'tabs'
    indentSize: 'auto', // 'auto' | number
    braceStyle: 'auto', // 'auto' | 'kr' | 'allman'
    language: 'auto',
    filename: '',
    isFile: false, // true when analysing a whole file (enables EOF checks)
  };

  const EXT = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'javascript', tsx: 'javascript',
    java: 'java',
    c: 'clike', h: 'clike', cpp: 'clike', cc: 'clike', cxx: 'clike',
    hpp: 'clike', cs: 'clike',
    py: 'python',
  };

  const LANG_LABEL = {
    javascript: 'JavaScript / TypeScript',
    java: 'Java',
    clike: 'C / C++ / C#',
    python: 'Python',
    generic: 'Generic',
  };

  const extOf = (name) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  };
  const langForFile = (name) => EXT[extOf(name)] || null;

  function guessLanguage(code) {
    if (/^\s*#include\b/m.test(code)) return 'clike';
    if (
      /\bSystem\.out\.print|\bpublic\s+static\s+void\s+main|\b(public|private|protected)\s+(static\s+)?(void|int|String|boolean|double)\b/.test(
        code
      )
    ) {
      return 'java';
    }
    if (
      /^\s*(def|class)\s+\w+.*:\s*$/m.test(code) ||
      /^\s*(elif|except)\b.*:\s*$/m.test(code) ||
      /^\s*(import\s+\w+|from\s+[\w.]+\s+import\s+.+)\s*$/m.test(code)
    ) {
      return 'python';
    }
    if (/\b(function|const|let|var)\b|=>|console\./.test(code)) return 'javascript';
    return 'generic';
  }

  /* ---------- small helpers ---------- */

  const toCamel = (s) =>
    s.replace(/_+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
  const toSnake = (s) =>
    s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
  const toPascal = (s) => {
    const c = toCamel(s.replace(/^_+/, ''));
    return c.charAt(0).toUpperCase() + c.slice(1);
  };

  function matchParen(m, open) {
    let d = 0;
    for (let k = open; k < m.length; k++) {
      if (m[k] === '(') d++;
      else if (m[k] === ')') {
        d--;
        if (d === 0) return k;
      }
    }
    return -1;
  }

  function applyEdits(line, edits) {
    // edits: {idx, del=0, ins=''} applied right-to-left
    const sorted = edits.slice().sort((a, b) => b.idx - a.idx);
    let out = line;
    for (const e of sorted) out = out.slice(0, e.idx) + (e.ins || '') + out.slice(e.idx + (e.del || 0));
    return out;
  }

  function lineIndexOf(starts, idx) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /* ---------- masking: blank out comments and string contents ---------- */

  function maskSource(src, lang) {
    const n = src.length;
    const out = src.split('');
    const cont = new Set(); // lines that begin inside a comment / multi-line string
    const hash = lang === 'python';
    let i = 0;
    let line = 0;

    const blank = (from, to) => {
      for (let k = from; k < to && k < n; k++) if (src[k] !== '\n') out[k] = ' ';
    };
    const nlIn = (from, to) => {
      let c = 0;
      for (let k = from; k < to && k < n; k++) if (src[k] === '\n') c++;
      return c;
    };

    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '\n') {
        line++;
        i++;
        continue;
      }
      if ((!hash && c === '/' && d === '/') || (hash && c === '#')) {
        let j = i;
        while (j < n && src[j] !== '\n') j++;
        blank(i, j);
        i = j;
        continue;
      }
      if (!hash && c === '/' && d === '*') {
        let j = src.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        blank(i, j);
        const nl = nlIn(i, j);
        for (let k = 1; k <= nl; k++) cont.add(line + k);
        line += nl;
        i = j;
        continue;
      }
      if (c === '"' || c === "'" || (c === '`' && lang === 'javascript')) {
        const triple =
          (lang === 'python' || (lang === 'java' && c === '"')) && src.startsWith(c.repeat(3), i);
        let j;
        if (triple) {
          const idx = src.indexOf(c.repeat(3), i + 3);
          const end = idx >= 0 ? idx : n;
          blank(i + 3, end);
          j = idx >= 0 ? idx + 3 : n;
        } else {
          j = i + 1;
          while (j < n) {
            if (src[j] === '\\') {
              j += 2;
              continue;
            }
            if (src[j] === c) break;
            if (src[j] === '\n' && c !== '`') break;
            j++;
          }
          if (j > n) j = n;
          blank(i + 1, j);
          if (j < n && src[j] === c) j++;
        }
        const nl = nlIn(i, j);
        for (let k = 1; k <= nl; k++) cont.add(line + k);
        line += nl;
        i = j;
        continue;
      }
      i++;
    }
    return { masked: out.join(''), cont };
  }

  /* ---------- main entry ---------- */

  function analyze(code, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    code = String(code == null ? '' : code).replace(/\r\n?/g, '\n');

    const lang =
      o.language && o.language !== 'auto'
        ? o.language
        : langForFile(o.filename) || guessLanguage(code);
    const lines = code.split('\n');
    const { masked, cont } = maskSource(code, lang);
    const mlines = masked.split('\n');
    const starts = [];
    {
      let p = 0;
      for (const l of lines) {
        starts.push(p);
        p += l.length + 1;
      }
    }
    const braceLang = lang === 'javascript' || lang === 'java' || lang === 'clike';
    const issues = [];
    const seen = new Set();

    function add(x) {
      const key = x.rule + '|' + x.line + '|' + (x.col || 0);
      if (seen.has(key)) return;
      seen.add(key);
      const range = x.range || [x.line, x.line];
      issues.push({
        rule: x.rule,
        severity: x.sev,
        line: x.line + 1,
        col: (x.col || 0) + 1,
        len: x.len || 0,
        message: x.message,
        hint: x.hint,
        answer: x.answer,
        range,
        originalLines: lines.slice(range[0], range[1] + 1),
        fix: x.fix == null ? null : x.fix,
      });
    }

    /* ----- structure pass: nesting depth per line ----- */
    const info = [];
    {
      let paren = 0;
      const bstack = [];
      for (let i = 0; i < mlines.length; i++) {
        const m = mlines[i];
        const rec = {
          paren,
          depth: bstack.length,
          inSwitch: bstack.some(Boolean),
        };
        for (let k = 0; k < m.length; k++) {
          const ch = m[k];
          if (ch === '(' || ch === '[') paren++;
          else if (ch === ')' || ch === ']') paren = Math.max(0, paren - 1);
          else if (ch === '{') {
            if (lang === 'python') paren++;
            else {
              let before = m.slice(0, k);
              if (!before.trim()) {
                let p = i - 1;
                while (p >= 0 && !mlines[p].trim()) p--;
                before = p >= 0 ? mlines[p] : '';
              }
              bstack.push(/\bswitch\b[^{;]*$/.test(before));
            }
          } else if (ch === '}') {
            if (lang === 'python') paren = Math.max(0, paren - 1);
            else bstack.pop();
          }
        }
        rec.parenEnd = paren;
        info.push(rec);
      }
    }

    const prevIdx = [];
    const nextIdx = [];
    {
      let last = -1;
      for (let i = 0; i < mlines.length; i++) {
        prevIdx[i] = last;
        if (mlines[i].trim()) last = i;
      }
      last = -1;
      for (let i = mlines.length - 1; i >= 0; i--) {
        nextIdx[i] = last;
        if (mlines[i].trim()) last = i;
      }
    }

    /* ----- indentation settings ----- */
    let tabLines = 0;
    let spaceLines = 0;
    lines.forEach((l, i) => {
      if (cont.has(i) || !l.trim()) return;
      if (l[0] === '\t') tabLines++;
      else if (l[0] === ' ') spaceLines++;
    });
    const effStyle =
      o.indentStyle === 'auto' ? (tabLines > spaceLines ? 'tabs' : 'spaces') : o.indentStyle;

    const leadSpaces = (l) => /^ */.exec(l)[0].length;
    function detectUnit() {
      const counts = {};
      for (let i = 0; i < lines.length; i++) {
        const p = prevIdx[i];
        if (p < 0 || !mlines[i].trim() || cont.has(i) || lines[i][0] !== ' ') continue;
        const opener = lang === 'python' ? /:\s*$/ : /\{\s*$/;
        if (!opener.test(mlines[p])) continue;
        const diff = leadSpaces(lines[i]) - leadSpaces(lines[p]);
        if (diff > 0 && diff <= 8) counts[diff] = (counts[diff] || 0) + 1;
      }
      let best = 4;
      let bestN = 0;
      for (const k of Object.keys(counts)) {
        if (counts[k] > bestN) {
          best = +k;
          bestN = counts[k];
        }
      }
      return best;
    }
    const unit = o.indentSize === 'auto' ? detectUnit() : Math.max(1, Number(o.indentSize) || 4);
    const indentOf = (levels) => (effStyle === 'tabs' ? '\t'.repeat(levels) : ' '.repeat(levels * unit));
    const max = Math.max(20, Number(o.maxLineLength) || 80);

    /* =====================  GENERIC RULES  ===================== */

    // Unbalanced brackets
    {
      const stack = [];
      const pairs = { ')': '(', ']': '[', '}': '{' };
      for (let idx = 0; idx < masked.length; idx++) {
        const ch = masked[idx];
        if (ch === '(' || ch === '[' || ch === '{') stack.push({ ch, idx });
        else if (ch === ')' || ch === ']' || ch === '}') {
          const top = stack[stack.length - 1];
          if (top && top.ch === pairs[ch]) stack.pop();
          else {
            const li = lineIndexOf(starts, idx);
            const col = idx - starts[li];
            const expected = top ? { '(': ')', '[': ']', '{': '}' }[top.ch] : null;
            add({
              rule: 'unbalanced-brackets',
              sev: 'error',
              line: li,
              col,
              len: 1,
              message: top
                ? `Found \`${ch}\` but the open \`${top.ch}\` from line ${lineIndexOf(starts, top.idx) + 1} still needs a \`${expected}\`.`
                : `Found a \`${ch}\` that doesn't have a matching opening bracket.`,
              hint: 'Brackets must pair up like parentheses in math. Walk backwards from here and count: which opener is this closer supposed to match?',
              answer: top
                ? `Close the \`${top.ch}\` with a \`${expected}\` before this \`${ch}\`, or remove the extra \`${ch}\` if it isn't needed.`
                : `Either remove this \`${ch}\`, or add the matching \`${pairs[ch]}\` earlier in the code.`,
              fix: null,
            });
            if (top) stack.pop();
          }
        }
      }
      for (const s of stack) {
        const li = lineIndexOf(starts, s.idx);
        add({
          rule: 'unbalanced-brackets',
          sev: 'error',
          line: li,
          col: s.idx - starts[li],
          len: 1,
          message: `This \`${s.ch}\` is never closed.`,
          hint: 'Something was opened here but the code ends (or changes block) before it is closed. Trace forward from this bracket: where should it end?',
          answer: `Add the matching \`${{ '(': ')', '[': ']', '{': '}' }[s.ch]}\` where this block, call or list ends.`,
          fix: null,
        });
      }
    }

    // Line length
    lines.forEach((line, i) => {
      const vis = line.replace(/\t/g, ' '.repeat(unit));
      if (vis.length <= max) return;
      if (/https?:\/\/\S{20,}\s*$/.test(line) && !mlines[i].trim()) return;
      const col = Math.max(0, Math.min(line.length - 1, max - (vis.length - line.length)));
      add({
        rule: 'line-length',
        sev: 'style',
        line: i,
        col,
        len: line.length - col,
        message: `Line is ${vis.length} characters long (the limit is ${max}).`,
        hint: 'Find a natural place to break this line: after a comma, before an operator, or inside a bracket. Where would a reader expect a pause?',
        answer: `Split the line so each row fits within ${max} characters. Indent the continuation one level deeper so it's clear it belongs to the line above.`,
        fix: wrapLine(line, mlines[i], max, indentOf(1)),
      });
    });

    // Trailing whitespace
    lines.forEach((line, i) => {
      const m = /[ \t]+$/.exec(line);
      if (!m) return;
      add({
        rule: 'trailing-whitespace',
        sev: 'style',
        line: i,
        col: m.index,
        len: m[0].length,
        message: line.trim() ? 'Trailing whitespace at the end of the line.' : 'Blank line contains spaces or tabs.',
        hint: "There's something invisible at the end of this line. Turn on \"show whitespace\" in your editor to spot it.",
        answer: 'Delete the spaces/tabs at the end of the line. Most editors can do this automatically on save.',
        fix: line.replace(/[ \t]+$/, ''),
      });
    });

    // Tabs vs spaces / mixed indentation
    lines.forEach((line, i) => {
      if (!line.trim() || cont.has(i)) return;
      const lead = /^[ \t]*/.exec(line)[0];
      if (!lead) return;
      const hasT = lead.includes('\t');
      const hasS = lead.includes(' ');
      const rest = line.slice(lead.length);
      if (hasT && hasS) {
        const width = lead.replace(/\t/g, ' '.repeat(unit)).length;
        const fixed =
          effStyle === 'tabs'
            ? '\t'.repeat(Math.floor(width / unit)) + ' '.repeat(width % unit) + rest
            : ' '.repeat(width) + rest;
        add({
          rule: 'mixed-indentation',
          sev: 'style',
          line: i,
          col: 0,
          len: lead.length,
          message: 'This line is indented with a mix of tabs and spaces.',
          hint: 'Different editors draw a tab at different widths, so mixed indentation can look aligned on your screen and crooked on someone else\u2019s. Pick one and stick with it.',
          answer: `Re-indent using only ${effStyle === 'tabs' ? 'tabs' : 'spaces'}, like the rest of the file.`,
          fix: fixed,
        });
        return;
      }
      if (effStyle === 'spaces' && hasT) {
        add({
          rule: 'tabs-vs-spaces',
          sev: 'style',
          line: i,
          col: 0,
          len: lead.length,
          message: 'Indented with tabs, but this file uses spaces.',
          hint: 'Compare how this line is indented to the lines around it. Which character is doing the indenting?',
          answer: `Replace each tab with ${unit} spaces (most editors have "convert indentation to spaces").`,
          fix: lead.replace(/\t/g, ' '.repeat(unit)) + rest,
        });
      } else if (effStyle === 'tabs' && hasS && lead.length >= unit && info[i].paren === 0) {
        add({
          rule: 'tabs-vs-spaces',
          sev: 'style',
          line: i,
          col: 0,
          len: lead.length,
          message: 'Indented with spaces, but this file uses tabs.',
          hint: 'Compare how this line is indented to the lines around it. Which character is doing the indenting?',
          answer: `Replace each group of ${unit} spaces with one tab.`,
          fix: '\t'.repeat(Math.floor(lead.length / unit)) + ' '.repeat(lead.length % unit) + rest,
        });
      }
    });

    // Too many blank lines
    {
      let run = 0;
      lines.forEach((line, i) => {
        if (!line.trim()) {
          run++;
          if (run === 3) {
            add({
              rule: 'blank-lines',
              sev: 'style',
              line: i,
              col: 0,
              len: 0,
              message: 'More than two blank lines in a row.',
              hint: 'Blank lines separate ideas. Do you really need this many to separate them?',
              answer: 'Keep at most one blank line between statements, and two between top-level sections.',
              fix: null,
            });
          }
        } else run = 0;
      });
    }

    // Missing newline at end of file (whole files only)
    if (o.isFile && code.length > 0 && !code.endsWith('\n')) {
      const li = lines.length - 1;
      add({
        rule: 'eof-newline',
        sev: 'style',
        line: li,
        col: lines[li].length,
        len: 0,
        message: 'File does not end with a newline.',
        hint: 'POSIX tools expect every line, including the last, to end with a line break.',
        answer: 'Press Enter once after the final line so the file ends with a newline.',
        fix: null,
      });
    }

    // TODO / FIXME
    lines.forEach((line, i) => {
      const m = /(\/\/|\/\*|^\s*\*|#).*?\b(TODO|FIXME|XXX|HACK)\b/.exec(line);
      if (!m || (lang !== 'python' && m[1] === '#' && lang !== 'clike')) return;
      add({
        rule: 'todo-comment',
        sev: 'style',
        line: i,
        col: m.index,
        len: m[0].length,
        message: `Unfinished work marker (${m[2]}) left in the code.`,
        hint: 'Is this still something you meant to come back to before submitting?',
        answer: 'Finish the task and delete the comment, or turn it into a ticket/issue so it is tracked properly.',
        fix: null,
      });
    });

    // Division by zero
    mlines.forEach((m, i) => {
      const r = /[\/%]\s*0(?![\w.])/.exec(m);
      if (!r) return;
      add({
        rule: 'division-by-zero',
        sev: 'error',
        line: i,
        col: r.index,
        len: r[0].length,
        message: 'Dividing (or taking a remainder) by a literal zero.',
        hint: "What does your computer do when you ask it to divide by 0? Can that number ever be a valid divisor here?",
        answer: 'Use a non-zero divisor, or check the divisor is not zero before dividing.',
        fix: null,
      });
    });

    /* =====================  PYTHON RULES  ===================== */

    if (lang === 'python') {
      const kw = /^(if|elif|else|for|while|def|class|try|except|finally|with|async|match|case)\b/;
      const stack = [0];
      let prevHeader = false;
      let prevBackslash = false;
      for (let i = 0; i < lines.length; i++) {
        const t = mlines[i].trim();
        if (!t) continue;
        if (cont.has(i) || info[i].paren > 0 || prevBackslash) {
          prevBackslash = /\\\s*$/.test(mlines[i]);
          continue;
        }
        prevBackslash = /\\\s*$/.test(mlines[i]);
        const lead = /^[ \t]*/.exec(lines[i])[0];
        const w = lead.replace(/\t/g, ' '.repeat(unit)).length;
        const top = stack[stack.length - 1];
        if (prevHeader) {
          if (w <= top) {
            add({
              rule: 'expected-indent',
              sev: 'error',
              line: i,
              col: 0,
              len: lead.length || 1,
              message: 'Expected an indented block after the line above ending in ":".',
              hint: 'A line ending in a colon opens a block. What has to be true about the next line?',
              answer: `Indent this line one level (${unit} spaces) deeper than the line above, or add \`pass\` if the block is intentionally empty.`,
              fix: null,
            });
          } else stack.push(w);
        } else if (w > top) {
          add({
            rule: 'unexpected-indent',
            sev: 'error',
            line: i,
            col: 0,
            len: lead.length || 1,
            message: 'Unexpected indent: this line is indented more than the code above for no reason.',
            hint: 'Python uses indentation to define blocks. Did the line before this one open a new block?',
            answer: `Remove the extra indentation so it lines up with the previous statement (${top} spaces).`,
            fix: ' '.repeat(top) + lines[i].trimStart(),
          });
          stack.push(w);
        } else if (w < top) {
          while (stack.length > 1 && stack[stack.length - 1] > w) stack.pop();
          if (stack[stack.length - 1] !== w) {
            add({
              rule: 'dedent-mismatch',
              sev: 'error',
              line: i,
              col: 0,
              len: lead.length || 1,
              message: 'Unindent does not match any outer indentation level.',
              hint: 'When you step back out of a block you need to land exactly on a column that an earlier line used. Which one is this line supposed to join?',
              answer: `Re-indent this line to match the block it belongs to (one of: ${stack.join(', ')} spaces).`,
              fix: null,
            });
            stack.push(w);
          }
        }
        if (w % unit !== 0) {
          add({
            rule: 'indent-size',
            sev: 'style',
            line: i,
            col: 0,
            len: lead.length || 1,
            message: `Indentation is ${w} spaces; it should be a multiple of ${unit}.`,
            hint: `Each nesting level should add the same number of spaces. Count how many this line uses versus the lines around it.`,
            answer: `Use multiples of ${unit} spaces per level.`,
            fix: ' '.repeat(Math.round(w / unit) * unit) + lines[i].trimStart(),
          });
        }
        if (stack.length - 1 >= 5 && !/^(else|elif|except|finally)\b/.test(t)) {
          add({
            rule: 'deep-nesting',
            sev: 'warning',
            line: i,
            col: 0,
            len: lead.length || 1,
            message: `Code is nested ${stack.length - 1} levels deep.`,
            hint: 'Deeply nested code is hard to read and test. Could an early return, `continue`, or a helper function flatten it?',
            answer: 'Extract the inner block into its own function, or use guard clauses (`if not x: return`) to reduce nesting.',
            fix: null,
          });
        }
        prevHeader = kw.test(t) && info[i].parenEnd === 0 && t.endsWith(':');

        // missing colon
        if (
          /^(if|elif|else|for|while|def|class|try|except|finally|with)\b/.test(t) &&
          info[i].parenEnd === 0 &&
          !/[:,\\]\s*$/.test(t) &&
          !t.includes(':')
        ) {
          add({
            rule: 'missing-colon',
            sev: 'error',
            line: i,
            col: mlines[i].trimEnd().length,
            len: 1,
            message: 'This block header is missing a colon at the end.',
            hint: 'Look at how the other `if`/`for`/`def` lines end. What is missing here?',
            answer: 'Add a `:` at the end of the line.',
            fix: lines[i].slice(0, mlines[i].trimEnd().length) + ':' + lines[i].slice(mlines[i].trimEnd().length),
          });
        }
      }

      mlines.forEach((m, i) => {
        const t = m.trim();
        if (!t) return;
        let r;
        // assignment in condition
        if ((r = /^(if|elif|while)\b(.*):$/.exec(t))) {
          const eq = findLoneEquals(r[2]);
          if (eq >= 0) {
            const idx = m.indexOf(r[2]) + eq;
            add({
              rule: 'assignment-in-condition',
              sev: 'error',
              line: i,
              col: idx,
              len: 1,
              message: 'Single `=` inside a condition: this assigns instead of comparing.',
              hint: 'In Python `=` stores a value. Which operator asks "are these two equal?"',
              answer: 'Use `==` to compare values.',
              fix: lines[i].slice(0, idx) + '==' + lines[i].slice(idx + 1),
            });
          }
        }
        // bare except
        if ((r = /^except\s*:/.exec(t))) {
          add({
            rule: 'bare-except',
            sev: 'warning',
            line: i,
            col: m.indexOf('except'),
            len: 6,
            message: 'Bare `except:` catches everything, even Ctrl+C and real bugs.',
            hint: 'What kinds of errors do you actually expect here? Can you name the exception?',
            answer: 'Catch the specific exception you expect (e.g. `except ValueError:`), or at least `except Exception:`.',
            fix: lines[i].replace(/except\s*:/, 'except Exception:'),
          });
        }
        // == None
        if ((r = /(==|!=)\s*None\b/.exec(m))) {
          const neg = r[1] === '!=';
          add({
            rule: 'none-comparison',
            sev: 'warning',
            line: i,
            col: r.index,
            len: r[0].length,
            message: `Compare to \`None\` with \`is${neg ? ' not' : ''}\`, not \`${r[1]}\`.`,
            hint: '`None` is a single object. Is there a keyword that checks identity rather than equality?',
            answer: `Write \`is${neg ? ' not' : ''} None\`.`,
            fix: lines[i].replace(/(==|!=)\s*None\b/, neg ? 'is not None' : 'is None'),
          });
        }
        // mutable default argument
        if ((r = /\bdef\s+\w+\s*\(.*=\s*(\[\s*\]|\{\s*\}|set\(\s*\))/.exec(m))) {
          add({
            rule: 'mutable-default',
            sev: 'error',
            line: i,
            col: m.indexOf(r[1]),
            len: r[1].length,
            message: 'Mutable default argument: the same list/dict is shared by every call.',
            hint: 'Default values are created once, when the function is defined, not each time it is called. What happens if you modify that default?',
            answer: 'Use `None` as the default and create the list/dict inside the function: `if items is None: items = []`.',
            fix: null,
          });
        }
        // Python 2 print
        if ((r = /^print\s+["'\w]/.exec(t))) {
          add({
            rule: 'print-statement',
            sev: 'error',
            line: i,
            col: m.indexOf('print'),
            len: 5,
            message: '`print` is a function in Python 3 and needs parentheses.',
            hint: 'Python 3 changed how `print` is called. How do you call other functions?',
            answer: 'Write `print(...)` with parentheses around what you want to print.',
            fix: lines[i].replace(/print\s+(.*)$/, 'print($1)'),
          });
        }
        // wildcard import
        if ((r = /^from\s+[\w.]+\s+import\s+\*/.exec(t))) {
          add({
            rule: 'wildcard-import',
            sev: 'style',
            line: i,
            col: m.indexOf('*'),
            len: 1,
            message: 'Wildcard import hides where names come from.',
            hint: 'If someone reads a function name later, can they tell which module it came from?',
            answer: 'Import only the names you use: `from module import name1, name2`.',
            fix: null,
          });
        }
        // naming
        if ((r = /^def\s+([a-z0-9]*[A-Z]\w*)\s*\(/.exec(t)) || (r = /^async\s+def\s+([a-z0-9]*[A-Z]\w*)\s*\(/.exec(t))) {
          addNaming(i, m, r[1], 'function', 'snake_case', toSnake(r[1]));
        }
        if ((r = /^class\s+([a-z_]\w*)/.exec(t))) {
          addNaming(i, m, r[1], 'class', 'PascalCase', toPascal(r[1]));
        }
        if ((r = /^([a-z]+[A-Z]\w*)\s*=(?!=)/.exec(t))) {
          addNaming(i, m, r[1], 'variable', 'snake_case', toSnake(r[1]));
        }
        // top-level def/class spacing (PEP 8)
        if (/^(def|class|async\s+def)\b/.test(m) && i > 0) {
          let p = i - 1;
          while (p >= 0 && (/^\s*@/.test(lines[p]) || /^\s*#/.test(lines[p]))) p--;
          if (p >= 0) {
            let blanks = 0;
            let q = p;
            while (q >= 0 && !lines[q].trim()) {
              blanks++;
              q--;
            }
            if (q >= 0 && blanks < 2) {
              add({
                rule: 'blank-lines-before-def',
                sev: 'style',
                line: i,
                col: 0,
                len: 3,
                message: 'Top-level functions and classes should be preceded by two blank lines.',
                hint: 'PEP 8 gives top-level definitions extra breathing room. Count the blank lines above this one.',
                answer: 'Put exactly two blank lines before top-level `def` and `class` statements.',
                fix: null,
              });
            }
          }
        }
      });

      // unreachable code
      mlines.forEach((m, i) => {
        const t = m.trim();
        if (!/^(return|raise|break|continue)\b/.test(t) || info[i].paren > 0 || info[i].parenEnd > 0) return;
        const n = nextIdx[i];
        if (n < 0 || cont.has(n)) return;
        const tn = mlines[n].trim();
        const wi = /^[ \t]*/.exec(lines[i])[0].length;
        const wn = /^[ \t]*/.exec(lines[n])[0].length;
        if (wi === wn && !/^(else|elif|except|finally|case)\b/.test(tn)) {
          add({
            rule: 'unreachable-code',
            sev: 'warning',
            line: n,
            col: wn,
            len: lines[n].trim().length,
            message: `This code can never run, the line above (\`${t.split(/\s/)[0]}\`) exits first.`,
            hint: 'Follow the flow of the program line by line. What happens when execution reaches the statement above?',
            answer: 'Delete the unreachable lines, or move them above the exit statement if they were meant to run.',
            fix: null,
          });
        }
      });

      checkImportsPython();
    }

    /* =====================  BRACE-LANGUAGE RULES  ===================== */

    if (braceLang) {
      // Indentation by brace depth
      lines.forEach((line, i) => {
        const t = mlines[i].trim();
        if (!t || cont.has(i) || info[i].paren > 0 || info[i].inSwitch) return;
        if (t[0] === '#' || /^(public|private|protected)\s*:/.test(t)) return;
        const p = prevIdx[i];
        if (p >= 0 && !/[{};]\s*$/.test(mlines[p])) return;
        if (p >= 0 && /^@\w+/.test(mlines[p].trim())) return;
        const lead = /^[ \t]*/.exec(line)[0];
        if (lead.includes('\t') && lead.includes(' ')) return;
        const depth = Math.max(0, info[i].depth - (t[0] === '}' ? 1 : 0));
        let width;
        let expected;
        if (effStyle === 'tabs') {
          if (lead.includes(' ')) return;
          width = lead.length;
          expected = depth;
        } else {
          if (lead.includes('\t')) return;
          width = lead.length;
          expected = depth * unit;
        }
        if (width !== expected) {
          const unitWord = effStyle === 'tabs' ? 'tab(s)' : 'spaces';
          add({
            rule: 'indentation',
            sev: 'style',
            line: i,
            col: 0,
            len: Math.max(1, lead.length),
            message: `Indentation looks off: expected ${expected} ${unitWord}, found ${width}.`,
            hint: 'Count how many `{` are still open at this line. Each open block adds one level of indentation. Does this line line up with its neighbours in the same block?',
            answer: `This line is ${depth} block${depth === 1 ? '' : 's'} deep, so it should be indented ${depth} level${depth === 1 ? '' : 's'} (${expected} ${unitWord}).`,
            fix: indentOf(depth) + line.trimStart(),
          });
        }
        // deep nesting
        if (t[0] !== '}' && depth >= 5) {
          const pd = p >= 0 ? Math.max(0, info[p].depth - (mlines[p].trim()[0] === '}' ? 1 : 0)) : 0;
          if (pd < 5) {
            add({
              rule: 'deep-nesting',
              sev: 'warning',
              line: i,
              col: 0,
              len: Math.max(1, lead.length),
              message: `Code is nested ${depth} levels deep.`,
              hint: 'Deeply nested code is hard to read and test. Could an early `return`/`continue` or a helper method flatten it?',
              answer: 'Pull the inner block into its own method, or use guard clauses to exit early and reduce nesting.',
              fix: null,
            });
          }
        }
      });

      // Brace placement
      {
        const HDR =
          '(?:\\)|\\belse|\\btry|\\bdo|\\bfinally|=>|->|\\b(?:class|interface|enum|struct|namespace)\\b[^{;]*)';
        const krRe = new RegExp(HDR + '\\s*\\{\\s*$');
        const hdrEnd = new RegExp(HDR + '\\s*$');
        const kr = [];
        const allman = [];
        mlines.forEach((m, i) => {
          const t = m.trim();
          if (cont.has(i) || !t) return;
          if (t === '{') {
            const p = prevIdx[i];
            if (p >= 0 && hdrEnd.test(mlines[p])) allman.push(i);
          } else if (krRe.test(m)) {
            kr.push(i);
          }
        });
        let style = o.braceStyle;
        if (style === 'auto') {
          style = allman.length > kr.length ? 'allman' : 'kr';
        }
        if (style === 'kr') {
          allman.forEach((i) => {
            const p = prevIdx[i];
            add({
              rule: 'brace-style',
              sev: 'style',
              line: i,
              col: lines[i].indexOf('{'),
              len: 1,
              range: [p, i],
              message: 'Opening brace is on its own line, but this code puts it at the end of the line before.',
              hint: 'Look at where the other blocks in this file put their `{`. Which line does it share?',
              answer: 'Move the `{` up to the end of the previous line (K&R style).',
              fix: lines[p].trimEnd() + ' {',
            });
          });
          // else / catch / finally on a new line after }
          mlines.forEach((m, i) => {
            if (cont.has(i)) return;
            const t = m.trim();
            const p = prevIdx[i];
            if (/^(else|catch|finally)\b/.test(t) && p >= 0 && mlines[p].trim() === '}') {
              add({
                rule: 'else-placement',
                sev: 'style',
                line: i,
                col: lines[i].search(/\S/),
                len: t.split(/\W/)[0].length,
                range: [p, i],
                message: `\`${t.split(/\W/)[0]}\` should sit on the same line as the closing brace.`,
                hint: 'Look at how `} else {` is usually written in this style. How many lines does it take?',
                answer: 'Join them: `} else {` on a single line.',
                fix: lines[p].trimEnd() + ' ' + lines[i].trim(),
              });
            }
          });
        } else {
          kr.forEach((i) => {
            const body = lines[i].replace(/\s*\{\s*$/, '');
            const lead = /^\s*/.exec(lines[i])[0];
            if (/^\s*\}/.test(lines[i]) && /\}\s*(else|catch|finally)/.test(lines[i])) return;
            add({
              rule: 'brace-style',
              sev: 'style',
              line: i,
              col: lines[i].lastIndexOf('{'),
              len: 1,
              message: 'Opening brace is at the end of the line, but this code puts it on its own line.',
              hint: 'Look at where the other blocks in this file put their `{`. Is it on the same line as the header or the next one?',
              answer: 'Move the `{` to its own line, aligned with the start of the block header (Allman style).',
              fix: body + '\n' + lead + '{',
            });
          });
        }
      }

      // Spacing: keywords, braces, operators, commas
      lines.forEach((line, i) => {
        const m = mlines[i];
        if (!m.trim() || (cont.has(i) && !m.trim())) return;
        const edits = [];
        let r;
        const kwRe = /\b(if|for|while|switch|catch)\(/g;
        while ((r = kwRe.exec(m))) edits.push({ idx: r.index + r[1].length, ins: ' ' });
        const braceRe = /\)\{/g;
        while ((r = braceRe.exec(m))) edits.push({ idx: r.index + 1, ins: ' ' });
        const wordBraceRe = /\b(else|try|finally|do)\{/g;
        while ((r = wordBraceRe.exec(m))) edits.push({ idx: r.index + r[1].length, ins: ' ' });
        const closeElse = /\}(else|catch|finally)\b/g;
        while ((r = closeElse.exec(m))) edits.push({ idx: r.index + 1, ins: ' ' });
        if (edits.length) {
          add({
            rule: 'keyword-spacing',
            sev: 'style',
            line: i,
            col: edits.slice().sort((a, b) => a.idx - b.idx)[0].idx,
            len: 1,
            message: 'Missing space after a keyword or before an opening brace.',
            hint: 'Compare `if(x){` with how the lines around it are written. Where would a space make this easier to scan?',
            answer: 'Put a space between the keyword and `(`, between `)` and `{`, and around `else`.',
            fix: applyEdits(line, edits),
          });
        }
      });
    }

    /* =====================  SPACING (all brace langs + python)  ===================== */

    if (lang !== 'generic') {
      lines.forEach((line, i) => {
        const m = mlines[i];
        const t = m.trim();
        if (!t || t[0] === '#' && lang !== 'python') return;
        // operators
        {
          const edits = [];
          let firstCol = -1;
          let firstOp = '';
          const re = /===|!==|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|%=|=>|=/g;
          let r;
          const jsx = /<[A-Za-z][\w.]*\s+[\w-]+=/.test(m);
          while ((r = re.exec(m))) {
            const op = r[0];
            const a = r.index;
            const b = a + op.length;
            const pv = m[a - 1];
            const nx = m[b];
            if (op === '=' || op === '<=' || op === '>=') {
              if (pv && /[<>&|^]/.test(pv)) continue;
            }
            if (op === '=' && nx === '=') continue;
            if (op === '=') {
              if (lang === 'python') {
                let depthHere = info[i].paren;
                for (let q = 0; q < a; q++) {
                  if ('([{'.includes(m[q])) depthHere++;
                  else if (')]}'.includes(m[q])) depthHere--;
                }
                if (depthHere > 0) continue;
              }
              if (jsx) continue;
              if (/^\s*@\w+/.test(m)) continue;
              if (info[i].paren > 0 && /@\w+\s*\(/.test(m)) continue;
            }
            const needBefore = a > 0 && pv !== ' ' && pv !== '\t' && pv !== undefined && a > m.search(/\S/);
            const needAfter = b < m.length && nx !== ' ' && nx !== '\t' && m.slice(b).trim() !== '';
            if (needBefore) edits.push({ idx: a, ins: ' ' });
            if (needAfter) edits.push({ idx: b, ins: ' ' });
            if ((needBefore || needAfter) && firstCol < 0) {
              firstCol = a;
              firstOp = op;
            }
          }
          if (edits.length) {
            add({
              rule: 'operator-spacing',
              sev: 'style',
              line: i,
              col: firstCol,
              len: firstOp.length,
              message: `Put a space on both sides of \`${firstOp}\`.`,
              hint: 'Operators read more easily with room around them. Compare how `a=b+c` looks with `a = b + c`.',
              answer: 'Add one space before and after assignment and comparison operators.',
              fix: applyEdits(line, edits),
            });
          }
        }
        // commas and for-semicolons
        {
          const edits = [];
          let firstCol = -1;
          let r;
          const missing = /,(?=[^\s)\]}\n])/g;
          while ((r = missing.exec(m))) {
            edits.push({ idx: r.index + 1, ins: ' ' });
            if (firstCol < 0) firstCol = r.index;
          }
          const before = /(\S)(\s+),/g;
          while ((r = before.exec(m))) {
            edits.push({ idx: r.index + 1, del: r[2].length });
            if (firstCol < 0) firstCol = r.index + 1;
          }
          if (/\bfor\s*\(/.test(m)) {
            const semi = /;(?=[^\s;)])/g;
            while ((r = semi.exec(m))) {
              edits.push({ idx: r.index + 1, ins: ' ' });
              if (firstCol < 0) firstCol = r.index;
            }
          }
          if (edits.length) {
            add({
              rule: 'punctuation-spacing',
              sev: 'style',
              line: i,
              col: firstCol,
              len: 1,
              message: 'Commas (and `for` semicolons) should have no space before and one space after.',
              hint: 'Read this line out loud as a sentence. Where would you pause, and does the spacing show that?',
              answer: 'Write `a, b` rather than `a,b` or `a , b`.',
              fix: applyEdits(line, edits),
            });
          }
        }
      });
    }

    /* =====================  BUG-HUNTING RULES (brace languages)  ===================== */

    if (braceLang) {
      const semiLines = mlines.filter((m) => /;\s*$/.test(m)).length;

      mlines.forEach((m, i) => {
        const t = m.trim();
        if (!t) return;
        const line = lines[i];
        let r;

        // assignment in condition
        if ((r = /\b(if|while)\s*\(/.exec(m))) {
          const open = r.index + r[0].length - 1;
          const close = matchParen(m, open);
          if (close > 0) {
            const eq = findLoneEquals(m.slice(open + 1, close));
            if (eq >= 0) {
              const idx = open + 1 + eq;
              const cmp = lang === 'javascript' ? '===' : '==';
              add({
                rule: 'assignment-in-condition',
                sev: 'error',
                line: i,
                col: idx,
                len: 1,
                message: 'Single `=` inside a condition: this assigns a value instead of comparing.',
                hint: 'One `=` stores a value; a different operator asks whether two things are equal. Which one does a condition need?',
                answer: `Use \`${cmp}\` to compare. (If the assignment is intentional, wrap it in an extra pair of parentheses and add a comment.)`,
                fix: line.slice(0, idx) + cmp + line.slice(idx + 1),
              });
            }
          }
        }

        // braceless bodies and stray semicolons
        {
          const rx = /(?:^|\belse\s+|\}\s*)(if|for|while)\s*\(/;
          const hm = rx.exec(m);
          if (hm && t[0] !== '#') {
            const kwIdx = hm.index + hm[0].lastIndexOf(hm[1]);
            const open = m.indexOf('(', kwIdx);
            const close = matchParen(m, open);
            if (close > 0) {
              const rest = m.slice(close + 1).trim();
              const lead = /^\s*/.exec(line)[0];
              const before = m.slice(0, kwIdx);
              if (rest === ';') {
                const doWhile = hm[1] === 'while' && before.includes('}');
                const prevEndsBrace = prevIdx[i] >= 0 && /\}\s*$/.test(mlines[prevIdx[i]]);
                if (!(hm[1] === 'while' && (doWhile || prevEndsBrace))) {
                  const semiIdx = m.indexOf(';', close);
                  add({
                    rule: 'stray-semicolon',
                    sev: 'error',
                    line: i,
                    col: semiIdx,
                    len: 1,
                    message: `A \`;\` right after \`${hm[1]} (...)\` ends the statement, so the body below isn't controlled by it.`,
                    hint: 'Look at the very end of this line. What does a semicolon there tell the compiler?',
                    answer: 'Delete the `;` so the statement (or the `{ ... }` block) that follows becomes the body.',
                    fix: line.slice(0, semiIdx) + line.slice(semiIdx + 1),
                  });
                }
              } else if (rest && rest[0] !== '{' && rest[0] !== ')' && !/^(&&|\|\||\?|:|\+|-|\*|\/|\.)/.test(rest)) {
                const head = line.slice(0, close + 1);
                const body = line.slice(close + 1).trim();
                add({
                  rule: 'braceless-body',
                  sev: 'style',
                  line: i,
                  col: close + 1,
                  len: Math.max(1, rest.length),
                  message: `\`${hm[1]}\` body has no braces.`,
                  hint: 'What happens if you later add a second statement under this line? Will it be part of the body?',
                  answer: 'Always use braces, even for a one-line body. It prevents bugs when the code is edited later.',
                  fix: `${head} {\n${lead}${indentOf(1)}${body}\n${lead}}`,
                });
              } else if (!rest && info[i].parenEnd === 0) {
                const n = nextIdx[i];
                if (n >= 0 && mlines[n].trim()[0] !== '{') {
                  add({
                    rule: 'braceless-body',
                    sev: 'style',
                    line: i,
                    col: close + 1,
                    len: 1,
                    message: `\`${hm[1]}\` body has no braces.`,
                    hint: 'What happens if you later add a second statement under this line? Will it be part of the body?',
                    answer: 'Wrap the body in `{ ... }`. It prevents bugs when the code is edited later.',
                    fix: null,
                  });
                }
              }
            }
          }
          const em = /(?:^|\})\s*else\b(?!\s*if\b)(.*)$/.exec(m);
          if (em && t[0] !== '#') {
            const rest = em[1].trim();
            const bad =
              (rest && rest[0] !== '{') ||
              (!rest && nextIdx[i] >= 0 && mlines[nextIdx[i]].trim()[0] !== '{');
            if (bad) {
              add({
                rule: 'braceless-body',
                sev: 'style',
                line: i,
                col: m.indexOf('else'),
                len: 4,
                message: '`else` body has no braces.',
                hint: 'What happens if you later add a second statement under this line? Will it be part of the else?',
                answer: 'Wrap the `else` body in `{ ... }`.',
                fix: null,
              });
            }
          }
        }

        // unreachable code
        if (/^(return\b.*;|break;|continue;|throw\b.*;)$/.test(t) && info[i].parenEnd === 0) {
          const p = prevIdx[i];
          const prevOk = p < 0 || /[{};]\s*$/.test(mlines[p]);
          const n = nextIdx[i];
          if (prevOk && n >= 0) {
            const tn = mlines[n].trim();
            if (tn[0] !== '}' && !/^(case|default|else|function)\b/.test(tn) && info[n].depth === info[i].depth && !cont.has(n)) {
              add({
                rule: 'unreachable-code',
                sev: 'warning',
                line: n,
                col: lines[n].search(/\S/),
                len: lines[n].trim().length,
                message: `This code can never run, the line above (\`${t.split(/\W/)[0]}\`) exits first.`,
                hint: 'Follow the flow of the program line by line. What happens when execution reaches the statement above?',
                answer: 'Delete the unreachable lines, or move them above the exit statement if they were meant to run.',
                fix: null,
              });
            }
          }
        }

        // missing semicolon
        if (lang !== 'javascript' || semiLines >= 3) {
          const tt = t;
          if (
            /^(?:final\s+)?(?:int|long|double|float|boolean|char|byte|short|String|const|let|var|break|continue|throw|return)\b/.test(tt) &&
            tt !== 'return' &&
            info[i].paren === 0 &&
            info[i].parenEnd === 0 &&
            /[\w)\]"'`]$/.test(tt) &&
            !(/\)$/.test(tt) && !/=/.test(tt))
          ) {
            const n = nextIdx[i];
            const tn = n >= 0 ? mlines[n].trim() : '';
            if (!tn || !/^[{.+\-*\/?:,&|)=<>\[]/.test(tn)) {
              const idx = m.trimEnd().length;
              add({
                rule: 'missing-semicolon',
                sev: 'error',
                line: i,
                col: idx,
                len: 1,
                message: 'This statement looks like it is missing a semicolon.',
                hint: 'Check how this line ends compared with the statements around it.',
                answer: 'Add `;` at the end of the statement.',
                fix: line.slice(0, idx) + ';' + line.slice(idx),
              });
            }
          }
        }

        // off-by-one in loops
        if ((r = /\bfor\b.*(<=)\s*[\w.$]+\.(?:length(?!\s*\()|length\s*\(\s*\)|size\s*\(\s*\))/.exec(m))) {
          const idx = m.indexOf('<=', r.index);
          add({
            rule: 'off-by-one',
            sev: 'warning',
            line: i,
            col: idx,
            len: 2,
            message: 'Loop runs one step too far: indexes stop at length - 1.',
            hint: 'If something has 5 items, what is the index of the last one? Will `<=` ever reach a value that does not exist?',
            answer: 'Use `<` instead of `<=` when looping up to `length` / `size()`.',
            fix: line.slice(0, idx) + '<' + line.slice(idx + 2),
          });
        }
      });

      // empty catch
      {
        const re = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;
        let r;
        while ((r = re.exec(masked))) {
          const orig = code.slice(r.index, r.index + r[0].length);
          if (/\/\/|\/\*/.test(orig)) continue;
          const li = lineIndexOf(starts, r.index);
          add({
            rule: 'empty-catch',
            sev: 'warning',
            line: li,
            col: r.index - starts[li],
            len: 5,
            message: 'Empty catch block silently swallows errors.',
            hint: 'If this fails, who will find out? What would you want to know when debugging?',
            answer: 'Handle the error (recover, log it, or rethrow). If ignoring is intentional, add a comment explaining why.',
            fix: null,
          });
        }
      }

      checkNamingBrace();
      checkUnusedBrace();
    }

    /* =====================  JAVASCRIPT-SPECIFIC  ===================== */

    if (lang === 'javascript') {
      mlines.forEach((m, i) => {
        const line = lines[i];
        let r;
        // loose equality
        const eqRe = /(===|!==|==|!=)/g;
        const eqEdits = [];
        let first = null;
        while ((r = eqRe.exec(m))) {
          if (r[0] === '===' || r[0] === '!==') continue;
          const after = m.slice(r.index + 2);
          const before = m.slice(0, r.index);
          if (/^\s*null\b/.test(after) || /\bnull\s*$/.test(before)) continue;
          eqEdits.push({ idx: r.index, del: 2, ins: r[0] === '==' ? '===' : '!==' });
          if (!first) first = r;
        }
        if (first) {
          add({
            rule: 'loose-equality',
            sev: 'warning',
            line: i,
            col: first.index,
            len: 2,
            message: `\`${first[0]}\` converts types before comparing, which causes surprising results.`,
            hint: 'JavaScript has a stricter comparison that also checks the type. What does `0 == "0"` give you, and what do you want?',
            answer: `Use \`${first[0] === '==' ? '===' : '!=='}\` so values of different types are never treated as equal.`,
            fix: applyEdits(line, eqEdits),
          });
        }
        if ((r = /\bvar\s+[A-Za-z_$]/.exec(m))) {
          add({
            rule: 'var-usage',
            sev: 'warning',
            line: i,
            col: r.index,
            len: 3,
            message: '`var` is function-scoped and hoisted, which leads to hard-to-find bugs.',
            hint: 'Modern JavaScript has two newer keywords for declaring variables. One is for values that never change. What are they?',
            answer: 'Use `const` by default, and `let` when you need to reassign.',
            fix: line.slice(0, r.index) + 'let' + line.slice(r.index + 3),
          });
        }
        if ((r = /\bconsole\.(log|debug|info)\s*\(/.exec(m))) {
          add({
            rule: 'debug-leftover',
            sev: 'style',
            line: i,
            col: r.index,
            len: r[0].length - 1,
            message: 'Debug output left in the code.',
            hint: 'Was this line for testing? Should it still be here when someone else runs your code?',
            answer: 'Remove it before submitting, or replace it with a proper logger.',
            fix: null,
          });
        }
        if (/^\s*debugger\s*;?\s*$/.test(m)) {
          add({
            rule: 'debugger-statement',
            sev: 'warning',
            line: i,
            col: m.indexOf('debugger'),
            len: 8,
            message: '`debugger` statement left in the code.',
            hint: "This line pauses the program in dev tools. Is that something you want in finished code?",
            answer: 'Delete the `debugger` statement.',
            fix: null,
          });
        }
        if ((r = /\beval\s*\(/.exec(m))) {
          add({
            rule: 'no-eval',
            sev: 'warning',
            line: i,
            col: r.index,
            len: 4,
            message: '`eval()` runs arbitrary strings as code, which is slow and a security risk.',
            hint: 'What would happen if the string passed in came from a user? Is there a safer built-in for the job (like `JSON.parse`)?',
            answer: 'Replace `eval` with a direct approach, e.g. `JSON.parse` for data or a lookup table for dispatch.',
            fix: null,
          });
        }
        if ((r = /\bparseInt\s*\(([^(),]*)\)/.exec(m))) {
          const argEnd = r.index + r[0].length - 1;
          add({
            rule: 'parseint-radix',
            sev: 'warning',
            line: i,
            col: r.index,
            len: 8,
            message: '`parseInt` without a radix can guess the wrong number base.',
            hint: 'Read the docs for `parseInt`: it takes a second argument. What does it control?',
            answer: 'Pass the base explicitly: `parseInt(value, 10)`.',
            fix: line.slice(0, argEnd) + ', 10' + line.slice(argEnd),
          });
        }
        if ((r = /(?:===|==|!==|!=)\s*NaN\b|\bNaN\s*(?:===|==|!==|!=)/.exec(m))) {
          add({
            rule: 'nan-comparison',
            sev: 'error',
            line: i,
            col: r.index,
            len: r[0].length,
            message: '`NaN` is never equal to anything, including itself, so this check is always false.',
            hint: 'Try `NaN === NaN` in the console. What does that tell you about testing for NaN?',
            answer: 'Use `Number.isNaN(value)` instead.',
            fix: null,
          });
        }
      });
      checkImportsJS();
    }

    /* =====================  JAVA-SPECIFIC  ===================== */

    if (lang === 'java') {
      mlines.forEach((m, i) => {
        const line = lines[i];
        let r;
        if ((r = /(==|!=)\s*"[^"]*"/.exec(m)) || (r = /"[^"]*"\s*(==|!=)/.exec(m))) {
          const neg = r[1] === '!=' || /!=/.test(r[0]);
          let fix = null;
          const fr = /([\w.]+(?:\([^()]*\))?)\s*(==|!=)\s*("(?:[^"\\]|\\.)*")/.exec(line);
          if (fr) {
            fix = line.replace(fr[0], `${fr[2] === '!=' ? '!' : ''}${fr[3]}.equals(${fr[1]})`);
          }
          add({
            rule: 'string-equality',
            sev: 'error',
            line: i,
            col: r.index,
            len: r[0].length,
            message: `\`${neg ? '!=' : '=='}\` on Strings compares references (memory addresses), not the text.`,
            hint: 'Two Strings with identical characters can still be different objects. Which String method compares the contents?',
            answer: `Use \`.equals()\` (or \`.equalsIgnoreCase()\`)${neg ? ' and negate it with `!`' : ''}. Putting the literal first avoids a NullPointerException.`,
            fix,
          });
        }
        if ((r = /\.printStackTrace\s*\(/.exec(m))) {
          add({
            rule: 'print-stack-trace',
            sev: 'style',
            line: i,
            col: r.index + 1,
            len: 15,
            message: '`printStackTrace()` is a debugging aid, not error handling.',
            hint: 'When the program fails for a real user, what should happen besides printing to the console?',
            answer: 'Log the exception with a logger, rethrow it, or recover from it.',
            fix: null,
          });
        }
      });
      checkImportsJava();
    }

    /* =====================  C-SPECIFIC  ===================== */

    if (lang === 'clike') {
      lines.forEach((line, i) => {
        const m = mlines[i];
        let r;
        if ((r = /\bgets\s*\(/.exec(m))) {
          add({
            rule: 'unsafe-gets',
            sev: 'error',
            line: i,
            col: r.index,
            len: 4,
            message: '`gets()` cannot limit input size and can overflow your buffer. It was removed from the C standard.',
            hint: 'How does `gets` know how big your buffer is? Is there a safer read function that takes a size?',
            answer: 'Use `fgets(buffer, sizeof buffer, stdin)` instead.',
            fix: null,
          });
        }
        if ((r = /\b(strcpy|strcat|sprintf)\s*\(/.exec(m))) {
          add({
            rule: 'unsafe-string-fn',
            sev: 'warning',
            line: i,
            col: r.index,
            len: r[1].length,
            message: `\`${r[1]}\` does not check the destination size and can overflow it.`,
            hint: 'What happens if the source is longer than the destination? Is there a "n" version of this function?',
            answer: `Use the bounded version (\`strncpy\`, \`strncat\`, \`snprintf\`) and always pass the destination size.`,
            fix: null,
          });
        }
        if (/\bscanf\s*\(\s*"[^"]*%s/.test(line)) {
          add({
            rule: 'unsafe-scanf',
            sev: 'warning',
            line: i,
            col: m.indexOf('scanf'),
            len: 5,
            message: '`%s` in `scanf` has no width limit and can overflow the buffer.',
            hint: 'How does `scanf` know where your buffer ends? Can the format specifier carry a limit?',
            answer: 'Give the format a maximum width, e.g. `%49s` for a 50-char buffer.',
            fix: null,
          });
        }
      });
    }

    /* ---------- shared helpers that need closure access ---------- */

    function addNaming(i, m, name, kind, conv, suggestion) {
      const idx = m.indexOf(name);
      add({
        rule: 'naming-convention',
        sev: 'style',
        line: i,
        col: idx,
        len: name.length,
        message: `${kind[0].toUpperCase() + kind.slice(1)} name \`${name}\` doesn't follow ${conv}.`,
        hint: `Look at how other ${kind}s in this language/community are usually named. What letter case and word separators do they use?`,
        answer: `Rename it to \`${suggestion}\` (${conv}). Use your IDE's rename refactoring so every usage updates too (Eclipse: Alt+Shift+R).`,
        fix: null,
      });
    }

    function checkNamingBrace() {
      mlines.forEach((m, i) => {
        let r;
        if (lang === 'java' || lang === 'clike') {
          if ((r = /^\s*(?:(?:public|private|protected|abstract|final|static|sealed)\s+)*(class|interface|enum)\s+([a-z]\w*)/.exec(m))) {
            addNaming(i, m, r[2], r[1], 'PascalCase', toPascal(r[2]));
          }
          if (lang === 'java') {
            if ((r = /\b(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],]+\s+([A-Z]\w*)\s*\(/.exec(m))) {
              addNaming(i, m, r[1], 'method', 'camelCase', toCamel(r[1]));
            }
            if ((r = /\b(?:int|long|double|float|boolean|char|byte|short|String)\s+([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*[=;,)]/.exec(m))) {
              addNaming(i, m, r[1], 'variable', 'camelCase', toCamel(r[1]));
            }
          }
        }
        if (lang === 'javascript') {
          if ((r = /\b(?:const|let|var)\s+([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/.exec(m))) {
            addNaming(i, m, r[1], 'variable', 'camelCase', toCamel(r[1]));
          }
          if ((r = /\bclass\s+([a-z]\w*)/.exec(m))) {
            addNaming(i, m, r[1], 'class', 'PascalCase', toPascal(r[1]));
          }
        }
      });
    }

    function wordCounts(text) {
      const counts = Object.create(null);
      const re = /[A-Za-z_$][\w$]*/g;
      let r;
      while ((r = re.exec(text))) counts[r[0]] = (counts[r[0]] || 0) + 1;
      return counts;
    }

    function checkUnusedBrace() {
      const counts = wordCounts(masked);
      const typeRe =
        lang === 'javascript'
          ? /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|;|$)/
          : /^\s*(?:final\s+)?(?:(?:unsigned\s+)?(?:int|long|double|float|boolean|bool|char|byte|short|size_t|auto)|String|[A-Z]\w*(?:<[^>]*>)?)(?:\[\])*\s+\*?([a-z_]\w*)\s*(?:=|;)/;
      mlines.forEach((m, i) => {
        const r = typeRe.exec(m);
        if (!r) return;
        const name = r[1];
        if (name === '_' || counts[name] !== 1) return;
        if (/^\s*(return|throw|new|else|import|package|using)\b/.test(m)) return;
        add({
          rule: 'unused-variable',
          sev: 'warning',
          line: i,
          col: m.indexOf(name),
          len: name.length,
          message: `Variable \`${name}\` is declared but never used.`,
          hint: 'Search the file for this name. Do you ever read the value, or was it left over from an earlier idea?',
          answer: 'Delete the variable, or use it. Unused variables often hide a typo or a forgotten step.',
          fix: null,
        });
      });
    }

    function importUsage(importRe, extractNames) {
      const kept = [];
      const importLines = [];
      mlines.forEach((m, i) => {
        if (importRe.test(m)) importLines.push(i);
        else kept.push(m);
      });
      const counts = wordCounts(kept.join('\n'));
      importLines.forEach((i) => {
        extractNames(mlines[i], lines[i]).forEach((name) => {
          if (!name || counts[name]) return;
          add({
            rule: 'unused-import',
            sev: 'warning',
            line: i,
            col: Math.max(0, mlines[i].indexOf(name)),
            len: name.length,
            message: `Import \`${name}\` is never used.`,
            hint: 'Search the file for this name. Is anything actually using it?',
            answer: 'Remove the import. Unused imports clutter the file and slow down reading.',
            fix: null,
          });
        });
      });
    }

    function checkImportsPython() {
      importUsage(/^\s*(import\s+\S|from\s+\S+\s+import\s+)/, (m) => {
        const names = [];
        let r;
        if ((r = /^\s*from\s+(\S+)\s+import\s+(.+)$/.exec(m))) {
          if (r[1] === '__future__') return [];
          r[2]
            .replace(/[()]/g, '')
            .split(',')
            .forEach((p) => {
              const s = p.trim().split(/\s+as\s+/);
              const n = (s[1] || s[0]).trim();
              if (n && n !== '*') names.push(n);
            });
        } else if ((r = /^\s*import\s+(.+)$/.exec(m))) {
          r[1].split(',').forEach((p) => {
            const s = p.trim().split(/\s+as\s+/);
            const n = s[1] ? s[1].trim() : s[0].trim().split('.')[0];
            if (n) names.push(n);
          });
        }
        return names;
      });
    }

    function checkImportsJava() {
      importUsage(/^\s*import\s+(?!static)[\w.]+\s*;/, (m) => {
        const r = /import\s+[\w.]*\.(\w+)\s*;/.exec(m);
        return r && r[1] !== '*' ? [r[1]] : [];
      });
    }

    function checkImportsJS() {
      importUsage(/^\s*import\s+[^'"]*from\s/, (m, orig) => {
        const names = [];
        let r;
        // use original for default/named clauses (strings are masked in m)
        const src = orig;
        if ((r = /import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/.exec(src))) names.push(r[1]);
        if ((r = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}/.exec(src))) {
          r[1].split(',').forEach((p) => {
            const s = p.trim().split(/\s+as\s+/);
            const n = (s[1] || s[0]).trim();
            if (n) names.push(n);
          });
        }
        if ((r = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(src))) names.push(r[1]);
        return names;
      });
    }

    /* ---------- finish ---------- */

    issues.sort((a, b) => a.line - b.line || a.col - b.col);
    const capped = issues.slice(0, 400);
    const counts = { error: 0, warning: 0, style: 0 };
    capped.forEach((x) => counts[x.severity]++);
    return {
      language: lang,
      languageLabel: LANG_LABEL[lang] || lang,
      issues: capped,
      truncated: issues.length > capped.length,
      counts,
      lines: lines.length,
      indent: { style: effStyle, unit },
    };
  }

  /* ---------- helpers used above (hoisted function declarations) ---------- */

  function findLoneEquals(inner) {
    let d = 0;
    for (let k = 0; k < inner.length; k++) {
      const ch = inner[k];
      if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') d--;
      else if (ch === '=' && d === 0) {
        const pv = inner[k - 1] || '';
        const nx = inner[k + 1] || '';
        if (nx === '=' || nx === '>') {
          k++;
          continue;
        }
        if ('=!<>+-*/%&|^:'.includes(pv) && pv !== '') continue;
        return k;
      }
    }
    return -1;
  }

  function wrapLine(line, m, max, contIndent) {
    if (/\t/.test(line)) return null;
    const lead = /^\s*/.exec(line)[0];
    const isComment = !m.trim() && /^\s*(\/\/+|#+|\*)/.test(line);
    if (isComment) {
      const pre = /^\s*(\/\/+|#+|\*)\s?/.exec(line)[0];
      const out = [];
      let rem = line;
      for (let g = 0; rem.length > max && g < 8; g++) {
        const cut = rem.lastIndexOf(' ', max);
        if (cut <= pre.length) break;
        out.push(rem.slice(0, cut).trimEnd());
        rem = pre + rem.slice(cut + 1).trimStart();
      }
      out.push(rem);
      return out.length > 1 ? out.join('\n') : null;
    }
    const cont = lead + contIndent.replace(/\t/g, '    ');
    const out = [];
    let rem = line;
    let rm = m;
    for (let g = 0; rem.length > max && g < 8; g++) {
      let cut = -1;
      for (let k = Math.min(max - 1, rem.length - 2); k > lead.length + 4; k--) {
        if (rm[k] === ',' && rm[k + 1] === ' ') {
          cut = k + 1;
          break;
        }
        if (rm[k] === ' ' && /^(&&|\|\||\+|-|\*|\/|\?|:|==|!=)\s/.test(rm.slice(k + 1))) {
          cut = k;
          break;
        }
      }
      if (cut < 0) break;
      out.push(rem.slice(0, cut).trimEnd());
      rem = cont + rem.slice(cut).trimStart();
      rm = cont + rm.slice(cut).trimStart();
    }
    out.push(rem);
    return out.length > 1 ? out.join('\n') : null;
  }

  const api = { analyze, langForFile, guessLanguage, LANG_LABEL, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CodeCoach = api;
})(typeof self !== 'undefined' ? self : this);
