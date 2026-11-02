// Shared by the search dialog and the viewer pane: where to search, ripgrep (which
// searches, previews replacements and replaces, so all three agree), the JS twin of the
// query (only to highlight lines rg didn't report), and highlighted code lines.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, exec, shared, home, readTextFile } from "herdr";

export const MAX_MATCHES = 5000;

// The focused terminal's folder (as the Files panel finds it), its git root if any.
export async function findRoot() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const last = shared("project-search.last");
  let cwd = pane?.cwd || f?.cwd || (last?.space === space?.id && last?.on === on ? last.root : null) || space?.folder || (on ? "" : home());
  try {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: cwd || undefined, on });
    if (r.code === 0 && r.stdout.trim()) cwd = r.stdout.trim();
  } catch {}
  return { root: cwd, on, space: space?.id ?? null };
}

// ripgrep's arguments for a query: the same ones list matches and list files to replace in.
export function rgArgs(q) {
  const a = ["--max-columns", "400", "--max-columns-preview", "--max-filesize", "1M", "--sort", "path", "--no-messages"];
  a.push(q.cased ? "-s" : "-i");
  if (q.word) a.push("-w");
  if (!q.regex) a.push("-F");
  if (q.ignored) a.push("-uu");
  for (const g of globs(q.include)) a.push("-g", g);
  for (const g of globs(q.exclude)) a.push("-g", "!" + g);
  return a;
}
const globs = (s) => (s ?? "").split(",").map((g) => g.trim()).filter(Boolean);

// Where rg is on a machine: PATH as exec sees it, then the usual install folders
// (Homebrew on Linux isn't always on a non-interactive shell's PATH). Kept per machine.
const RG = new Map();
async function rgPath(on) {
  if (RG.has(on ?? "")) return RG.get(on ?? "");
  const tries = ["rg", "/home/linuxbrew/.linuxbrew/bin/rg", "/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg", "$HOME/.cargo/bin/rg", "$HOME/.local/bin/rg", "/nix/var/nix/profiles/default/bin/rg"];
  for (const c of tries) {
    try {
      const r = await exec("sh", ["-c", `p="${c}"; "$p" --version >/dev/null 2>&1 && command -v "$p"`], { on });
      if (r.code === 0 && r.stdout.trim()) { RG.set(on ?? "", r.stdout.trim()); return r.stdout.trim(); }
    } catch {}
  }
  throw new Error(on ? `ripgrep (rg) isn't installed on ${on}` : "ripgrep (rg) isn't installed");
}

const LIMIT = 12000;
const rel = (p) => p.replace(/^\.\//, "");
const rgError = (err) => err.includes("regex parse error") ? "Invalid regex: " + err.split("\n").pop().replace(/^error: /, "") : err.split("\n").pop();

// Reads rg --json events into files. Each file: `matches` (line, text, ranges) and
// `lines`: the matches and, with context, the lines around them, in order.
class Parser {
  constructor() { this.files = []; this.cur = null; this.count = 0; this.capped = false; }

  // One line of rg --json. False once MAX_MATCHES is reached.
  feed(ln) {
    if (!ln) return true;
    let ev;
    try { ev = JSON.parse(ln); } catch { return true; }
    if (ev.type === "begin") {
      const p = ev.data.path.text;
      this.cur = p == null ? null : { path: rel(p), matches: [], lines: [] };
    } else if ((ev.type === "match" || ev.type === "context") && this.cur) {
      const text = ev.data.lines.text;
      if (text == null) return true;
      const line = text.replace(/\r?\n$/, "");
      if (ev.type === "context") { this.cur.lines.push({ line: ev.data.line_number, text: line, ranges: null }); return true; }
      const m = { line: ev.data.line_number, text: line, ranges: ev.data.submatches.map((s) => [charIndex(line, s.start), charIndex(line, s.end)]) };
      this.cur.matches.push(m);
      this.cur.lines.push(m);
      if (++this.count >= MAX_MATCHES) { this.capped = true; this.end(); return false; }
    } else if (ev.type === "end") this.end();
    return true;
  }

  end() {
    if (this.cur?.matches.length) this.files.push(this.cur);
    this.cur = null;
  }

  // What's in so far, including the file rg is still in the middle of.
  snapshot() {
    const files = this.cur?.matches.length ? [...this.files, this.cur] : this.files.slice();
    return { files, count: this.count, capped: this.capped };
  }
}

const searchArgs = (q) => ["--json", "-m", "200", ...(q.context ? ["-C", "1"] : []), ...rgArgs(q), "-e", q.query, "--", "."];

// One-shot search (another machine): rg --json, capped by line count so huge result sets
// stop rg (SIGPIPE) instead of filling memory.
export async function search(q, root, on) {
  const r = await exec("sh", ["-c", `"$0" "$@" | head -n ${LIMIT}`, await rgPath(on), ...searchArgs(q)], { cwd: root, on });
  const p = new Parser();
  for (const ln of r.stdout.split("\n")) if (!p.feed(ln)) break;
  p.end();
  const err = r.stderr.trim();
  if (!p.files.length && err) throw new Error(rgError(err));
  return { ...p.snapshot(), capped: p.capped || r.stdout.split("\n").length >= LIMIT };
}

// A streaming search on this machine: rg runs in the background into a temp file, and
// poll() reads what's new, so results show while rg is still walking a big repo.
// stop() kills rg (a newer query, the dialog closing, the match cap).
export class SearchStream {
  constructor(q, root) {
    this.q = q; this.root = root; this.parser = new Parser();
    this.file = null; this.pid = null; this.offset = 0; this.rest = ""; this.stopped = false; this.done = false; this.error = null;
  }

  async start() {
    const rg = await rgPath(null);
    const r = await exec("sh", ["-c", 'f=$(mktemp) || exit 1; "$0" "$@" >"$f" 2>"$f.err" </dev/null & echo "$f $!"', rg, ...searchArgs(this.q)], { cwd: this.root });
    const [file, pid] = r.stdout.trim().split(" ");
    if (!file || !pid) throw new Error(r.stderr.trim() || "Couldn't start ripgrep");
    this.file = file; this.pid = pid;
    if (this.stopped) await this.cleanup(true);
  }

  // Waits a moment, reads what rg wrote since last time. Resolves to true when finished.
  async poll(wait) {
    if (this.done || this.stopped) return true;
    const CHUNK = 1500000;
    const r = await exec("sh", ["-c", 'sleep "$3"; a=0; kill -0 "$2" 2>/dev/null && a=1; tail -c +"$1" "$0" 2>/dev/null | head -c ' + CHUNK + '; printf "%s" "$a" >&2',
      this.file, String(this.offset + 1), this.pid, String(wait)]);
    if (this.stopped) return true;
    const alive = r.stderr.trim().endsWith("1");
    const text = r.stdout, cut = text.lastIndexOf("\n");
    const whole = cut < 0 ? "" : text.slice(0, cut + 1);
    this.offset += utf8Length(whole);
    for (const ln of whole.split("\n")) {
      if (!this.parser.feed(ln)) { await this.cleanup(true); this.done = true; return true; }
    }
    // rg had exited before this read, and the read got everything: that's all of it.
    if (!alive && utf8Length(text) < CHUNK) {
      const err = await exec("cat", [this.file + ".err"]).then((x) => x.stdout.trim()).catch(() => "");
      this.parser.end();
      if (!this.parser.files.length && err) this.error = rgError(err);
      this.done = true;
      await this.cleanup(false);
    }
    return this.done;
  }

  snapshot() {
    return this.parser.snapshot();
  }

  async stop() {
    if (this.stopped || this.done) return;
    this.stopped = true;
    if (this.file) await this.cleanup(true);
  }

  async cleanup(kill) {
    if (!this.file) return;
    await exec("sh", ["-c", (kill ? 'kill "$1" 2>/dev/null; ' : "") + 'rm -f "$0" "$0.err"', this.file, this.pid]).catch(() => {});
  }
}

function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// ripgrep's own replacement syntax ($1, ${name}); typed text stays as typed.
const rgReplacement = (q) => (q.regex ? q.replace : q.replace.replace(/\$/g, "$$$$"));

// What each match becomes, as ripgrep computes it (the same engine that writes):
// "path:line" -> one replacement per match, in order.
export async function replacements(q, root, on) {
  const args = ["-o", `--replace=${rgReplacement(q)}`, "-n", "-H", "-0", "--color", "never", "-m", "200", ...rgArgs(q), "-e", q.query, "--", "."];
  const r = await exec("sh", ["-c", `"$0" "$@" | head -n ${LIMIT}`, await rgPath(on), ...args], { cwd: root, on });
  const out = new Map();
  for (const ln of r.stdout.split("\n")) {
    const z = ln.indexOf("\0");
    if (z < 0) continue;
    const rest = ln.slice(z + 1), c = rest.indexOf(":");
    const key = `${rel(ln.slice(0, z))}:${rest.slice(0, c)}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(rest.slice(c + 1).replace(/\r$/, ""));
  }
  return out;
}

// Every file the query matches (no cap) with its match count: what Replace all touches.
export async function matchingFiles(q, root, on) {
  const r = await exec(await rgPath(on), ["--count-matches", "-0", ...rgArgs(q), "-e", q.query, "--", "."], { cwd: root, on });
  if (r.code > 1) throw new Error(rgError(r.stderr.trim()) || "ripgrep failed");
  return r.stdout.split("\n").filter(Boolean).map((l) => {
    const [p, n] = l.split("\0");
    return { path: rel(p), count: Number(n) || 0 };
  });
}

// A file with the query replaced by ripgrep (--passthru prints every line, matches
// replaced). `line`: only that line changes. Returns { path, before, after } to write;
// throws if the file changed meanwhile. No --max-columns here: it would blank long lines.
export async function replaceInFile(q, root, on, file, line = null) {
  const path = `${root}/${file}`;
  const before = await readTextFile(path, { on });
  if (before == null) throw new Error("it's gone");
  if (before.includes("\0")) throw new Error("it's binary");
  const args = ["--passthru", "-N", "--no-filename", "--color", "never", "-a", q.cased ? "-s" : "-i", ...(q.word ? ["-w"] : []), ...(q.regex ? [] : ["-F"]),
    `--replace=${rgReplacement(q)}`, "-e", q.query, "--", file];
  const r = await exec(await rgPath(on), args, { cwd: root, on });
  if (r.code > 1) throw new Error(rgError(r.stderr.trim()));
  let after = r.stdout;
  if (!before.endsWith("\n") && after.endsWith("\n")) after = after.slice(0, -1);
  if (line != null) {
    const b = before.split("\n"), a = after.split("\n");
    if (a.length !== b.length) throw new Error("the replacement adds lines");
    b[line - 1] = a[line - 1];
    after = b.join("\n");
  }
  if ((await readTextFile(path, { on })) !== before) throw new Error("it changed while replacing");
  return { path, before, after };
}

// rg reports UTF-8 byte offsets; JS strings index UTF-16 units.
function charIndex(s, byte) {
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    if (b >= byte) return i;
    const c = s.charCodeAt(i);
    if (c < 0x80) b += 1;
    else if (c < 0x800) b += 2;
    else if (c >= 0xd800 && c < 0xdc00) { b += 4; i++; }
    else b += 3;
  }
  return s.length;
}

// The query as a JS RegExp (global). Throws on a pattern JS can't read.
export function toRegExp(q) {
  let src = q.regex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (q.word) src = `\\b(?:${src})\\b`;
  const flags = "g" + (q.cased ? "" : "i");
  try { return new RegExp(src, flags + "u"); } catch { return new RegExp(src, flags); }
}

// Match ranges in a line, for highlighting (the viewer and the preview).
export function rangesIn(re, line) {
  if (!re) return [];
  const out = [];
  re.lastIndex = 0;
  let m, guard = 0;
  while ((m = re.exec(line)) && guard++ < 200) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// A theme color at an opacity (theme colors are #rrggbb or #rrggbbaa).
export const alpha = (c, a) => (c?.startsWith("#") ? c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0") : c);

const untab = (s) => s.replace(/\t/g, "    ");

// Text with highlighted ranges, as one row of segments. `repl`: show each match struck
// through, followed by what it becomes.
export function segments(t, text, ranges, opts = {}) {
  const out = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(div().flex_none().child(untab(text.slice(at, s))));
    const hit = text.slice(s, e);
    if (opts.repl != null) {
      out.push(div().flex_none().bg(alpha(t.blocked, 0.2)).text_color(t.blocked).line_through().child(untab(hit)));
      const r = opts.repl(i);
      if (r) out.push(div().flex_none().bg(alpha(t.working, 0.2)).text_color(t.working).child(untab(r)));
    } else {
      out.push(div().flex_none().rounded(2).bg(alpha(t.accent, opts.current === i ? 0.55 : 0.3)).text_color(t.foreground).child(untab(hit)));
    }
    at = e;
  });
  if (at < text.length) out.push(div().flex_none().child(untab(text.slice(at))));
  return h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().children(out);
}

// One code line: number, text with highlights; `hot` marks the line of the selected match.
export function codeLine(t, n, text, ranges, hot, font, gutter) {
  return h_flex().h(20).w_full().items_center().when(hot, (el) => el.bg(alpha(t.selection, 0.5)))
    .child(div().w(gutter).flex_none().pr(12).text_right().text_color(hot ? t.foreground : t.dim).child(String(n)))
    .child(segments(t, text, ranges).text_color(t.muted).font_family(font));
}

export const gutterWidth = (lines) => 20 + String(lines).length * 8;
