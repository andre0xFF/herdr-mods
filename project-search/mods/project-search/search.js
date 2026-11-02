// The search dialog: query, replace and filter inputs, results grouped by file (with a
// line of context around matches) on the left, the selected match in its file on the right.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { run, theme, settings, props, closeOverlay, shared, setShared, focused, panes, home, readTextFile, writeTextFile } from "herdr";
import { findRoot, search, SearchStream, replacements, matchingFiles, replaceInFile, toRegExp, rangesIn, segments, codeLine, gutterWidth, alpha, MAX_MATCHES } from "./lib.js";
import { fileIcon } from "./icons.js";

const H = { file: 30, line: 24, gap: 12 };
const OPTIONS = ["cased", "word", "regex", "ignored"];
const HISTORY = 40;
const FIELDS = ["query", "replace", "include", "exclude"];
const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;

export class SearchDialog {
  init(cx) {
    const last = shared("project-search.last") ?? {};
    this.q = { query: last.query ?? "", replace: last.replace ?? "", include: last.include ?? "", exclude: last.exclude ?? "" };
    for (const o of OPTIONS) this.q[o] = Boolean(last[o]);
    this.q.context = last.context ?? true;
    this.showReplace = Boolean(last.showReplace);
    this.showFilters = Boolean(last.include || last.exclude || last.ignored);
    this.results = null; this.rows = []; this.matchRows = []; this.sel = 0;
    this.collapsed = new Set(); this.files = new Map(); this.repl = new Map();
    this.error = null; this.loading = false; this.note = null; this.undo = null; this.confirm = null; this.busy = false;
    this.seq = 0; this.replSeq = 0; this.pending = 0; this.focusAt = 0; this.histAt = -1; this.lastSecondary = 0;
    this.handle = cx.focus_handle();
    this.listScroll = VirtualListScrollHandle.new();
    this.pvScroll = VirtualListScrollHandle.new();

    const input = (key, placeholder) => {
      const s = InputState.new({ placeholder, value: this.q[key] });
      s.on("change", (_e, cx) => {
        if (s.value() === this.q[key]) return;
        this.q[key] = s.value();
        if (key === "query" && !this.recalling) this.histAt = -1;
        this.schedule(cx, key === "replace" ? "replace" : "search");
        this.confirm = null;
        cx.notify();
      });
      return s;
    };
    this.inputs = {
      query: input("query", "Search project…"),
      replace: input("replace", "Replace with… ($1 for groups in regex mode)"),
      include: input("include", "Include: src/**, *.ts"),
      exclude: input("exclude", "Exclude: *.lock, dist/**"),
    };
    // Enter: open (replace in the replace field). Ctrl+Enter may arrive here, as a key,
    // or both, depending on the input; secondary() runs it once either way.
    for (const k of FIELDS) {
      this.inputs[k].on("submit", (e, cx) => {
        if (e.secondary) this.secondary(cx);
        else if (k === "replace") this.replaceOne(cx);
        else this.open();
        cx.notify();
      });
      this.inputs[k].on("focus", (_e, cx) => { this.focusAt = FIELDS.indexOf(k); cx.notify(); });
    }
    this.inputs.query.focus();
    cx.timer.after(300, () => this.inputs.query.focus());

    cx.spawn(async (cx) => {
      Object.assign(this, await findRoot());
      if (this.q.query) this.run(cx);
      cx.notify();
    });
  }

  close() {
    this.stream?.stop();
    this.stream = null;
    this.remember();
    setShared("project-search.last", { ...this.q, showReplace: this.showReplace, root: this.root, on: this.on, space: this.space });
  }

  // History: queries you opened, replaced with, or left the dialog on. ctrl-↑/↓ recall them.

  remember() {
    const q = this.q.query;
    if (!q) return;
    const h = (shared("project-search.history") ?? []).filter((x) => x !== q);
    setShared("project-search.history", [q, ...h].slice(0, HISTORY));
  }

  recall(by, cx) {
    if (this.histAt === -1) this.typed = this.q.query;
    const h = (shared("project-search.history") ?? []).filter((x) => x !== this.typed);
    const at = Math.max(-1, Math.min(this.histAt + by, h.length - 1));
    if (at === this.histAt) return;
    this.histAt = at;
    const value = at === -1 ? this.typed ?? "" : h[at];
    this.recalling = true;
    this.inputs.query.set_value(value);
    this.recalling = false;
    this.q.query = value;
    this.inputs.query.focus();
    this.schedule(cx, "search");
  }

  // Searching

  schedule(cx, what) {
    const n = ++this.pending;
    cx.timer.after(160, (cx) => {
      if (n !== this.pending) return;
      if (what === "replace") this.fetchRepl(cx);
      else this.run(cx);
    });
  }

  // Here: rg streams, so results show as they come and a newer query kills the older rg.
  // Another machine: one search, shown when it's done.
  run(cx, keep = false) {
    const seq = ++this.seq, q = { ...this.q };
    this.stream?.stop();
    this.stream = null;
    if (!q.query || this.root == null) {
      this.results = null; this.error = null; this.loading = false; this.repl = new Map(); this.rebuild(); cx.notify();
      return;
    }
    this.loading = true;
    cx.notify();
    const show = (r, first) => {
      this.results = r; this.error = null;
      if (first && !keep) { this.sel = 0; this.collapsed = new Set(); }
      if (first) this.files.clear();
      const had = this.matchRows.length;
      this.rebuild();
      if (first || !had) this.follow(cx);
    };
    const finish = (error) => {
      if (error !== undefined) { this.results = null; this.error = error; this.rebuild(); }
      this.loading = false;
      this.fetchRepl(cx);
      cx.notify();
    };
    cx.spawn(async (cx) => {
      if (this.on) {
        try {
          const r = await search(q, this.root, this.on);
          if (seq === this.seq) { show(r, true); finish(); }
        } catch (e) {
          if (seq === this.seq) finish(String(e?.message ?? e));
        }
        return;
      }
      const stream = this.stream = new SearchStream(q, this.root);
      try {
        await stream.start();
        let first = true;
        for (let wait = 0.03; ; wait = Math.min(0.25, wait * 2)) {
          const done = await stream.poll(wait);
          if (seq !== this.seq) return;
          if (first || stream.snapshot().count !== this.results?.count || done) { show(stream.snapshot(), first); first = false; }
          cx.notify();
          if (done) break;
        }
        if (this.stream === stream) this.stream = null;
        finish(stream.error ?? undefined);
      } catch (e) {
        stream.stop();
        if (seq === this.seq) finish(String(e?.message ?? e));
      }
    });
  }

  // What each shown match becomes, from ripgrep: the engine that will write it.
  fetchRepl(cx) {
    const seq = ++this.replSeq, q = { ...this.q };
    if (!this.showReplace || !q.query || !this.results?.count) { this.repl = new Map(); return; }
    cx.spawn(async (cx) => {
      try {
        const m = await replacements(q, this.root, this.on);
        if (seq === this.replSeq) this.repl = m;
      } catch {
        if (seq === this.replSeq) this.repl = new Map();
      }
      cx.notify();
    });
  }

  // Flat rows: a file header, then its lines in runs (a gap row between runs).
  // Each run loses its common indent; only match rows can be selected.
  rebuild() {
    this.rows = []; this.matchRows = [];
    for (const f of this.results?.files ?? []) {
      this.rows.push({ kind: "file", f });
      if (this.collapsed.has(f.path)) continue;
      const runs = [];
      for (const l of f.lines) {
        const run = runs[runs.length - 1];
        if (run && l.line === run[run.length - 1].line + 1) run.push(l);
        else runs.push([l]);
      }
      runs.forEach((run, ri) => {
        if (ri && this.q.context) this.rows.push({ kind: "gap" });
        const indents = run.filter((l) => l.text.trim()).map((l) => l.text.match(/^\s*/)[0].length);
        const indent = indents.length ? Math.min(...indents) : 0;
        for (const l of run) {
          if (l.ranges) this.matchRows.push(this.rows.length);
          this.rows.push({ kind: "line", f, l, indent, m: l.ranges ? l : null });
        }
      });
    }
    this.sel = Math.max(0, Math.min(this.sel, this.matchRows.length - 1));
  }

  selected() {
    return this.rows[this.matchRows[this.sel]] ?? null;
  }

  regex() {
    try { return toRegExp(this.q); } catch { return null; }
  }

  // Keeps the selection on screen and its file in the preview.
  follow(cx) {
    const r = this.selected();
    if (!r) return;
    this.listScroll.scroll_to_item(this.matchRows[this.sel], "center");
    const path = r.f.path;
    const cached = this.files.get(path);
    if (cached?.lines) { this.pvScroll.scroll_to_item(r.m.line - 1, "center"); return; }
    if (cached) return;
    this.files.set(path, { loading: true });
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${this.root}/${path}`, { on: this.on });
        this.files.set(path, text == null ? { error: "This file is no longer there" } : { lines: text.split("\n").map((l) => l.replace(/\r$/, "")) });
      } catch {
        this.files.set(path, { error: "Can't preview this file (too large or unreadable)" });
      }
      const now = this.selected();
      if (now?.f.path === path) this.pvScroll.scroll_to_item(now.m.line - 1, "center");
      cx.notify();
    });
  }

  move(by, cx) {
    if (!this.matchRows.length) return;
    const n = this.matchRows.length;
    this.sel = Math.abs(by) > 1 ? Math.max(0, Math.min(this.sel + by, n - 1)) : (this.sel + by + n) % n;
    this.confirm = null;
    this.follow(cx);
  }

  toggle(o, cx) {
    this.q[o] = !this.q[o];
    this.run(cx, o === "context");
  }

  toggleReplace(cx) {
    this.showReplace = !this.showReplace;
    this.inputs[this.showReplace ? "replace" : "query"].focus();
    this.fetchRepl(cx);
  }

  toggleFilters() {
    this.showFilters = !this.showFilters;
    this.inputs[this.showFilters ? "include" : "query"].focus();
  }

  // Ctrl+Enter: confirm a pending Replace all, else ask for one, else open.
  secondary(cx) {
    const now = Date.now();
    if (now - this.lastSecondary < 250) return;
    this.lastSecondary = now;
    if (this.confirm?.files.length) this.replaceAll(cx);
    else if (this.showReplace) this.askReplaceAll(cx);
    else this.open();
  }

  // Opening a match in a viewer pane beside the shell (replacing an earlier one).

  open() {
    const r = this.selected();
    if (!r) return;
    this.close();
    closeOverlay(props().overlay);
    const f = focused();
    const old = panes().find((p) => p.tab === f?.tab && p.mod === "project-search");
    const viewProps = {
      file: r.f.path, root: this.root, on: this.on, line: r.m.line,
      search: { query: this.q.query, cased: this.q.cased, word: this.q.word, regex: this.q.regex },
    };
    const target = f?.pane && f.pane !== old?.pane ? f.pane : undefined;
    if (old) run("pane.close", { pane: old.pane });
    if (target || old) run("pane.split", { direction: "right", mod: "project-search", props: viewProps, ...(target ? { pane: target } : {}) });
    else run("tab.new", { name: r.f.path.split("/").pop(), mod: "project-search", props: viewProps });
  }

  // Replacing, by ripgrep. Files are written only if unchanged since read, and kept for Undo.

  canReplace() {
    return !this.on && Boolean(this.results?.count) && !this.busy;
  }

  replaceOne(cx) {
    const r = this.selected();
    if (!r || !this.canReplace()) return;
    const q = { ...this.q };
    this.busy = true;
    this.remember();
    cx.spawn(async (cx) => {
      try {
        const x = await replaceInFile(q, this.root, this.on, r.f.path, r.m.line);
        if (x.after === x.before) this.note = "Nothing to replace there now";
        else {
          await writeTextFile(x.path, x.after, x.before);
          this.undo = [x];
          this.note = `Replaced ${plural(r.m.ranges.length, "match", "matches")} in ${r.f.path}:${r.m.line}`;
        }
      } catch (e) {
        this.note = `Didn't replace: ${e?.message ?? e}`;
      }
      this.busy = false;
      this.run(cx, true);
    });
  }

  askReplaceAll(cx) {
    if (!this.canReplace()) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const files = await matchingFiles(this.q, this.root, this.on);
        this.confirm = { files, total: files.reduce((n, f) => n + f.count, 0) };
      } catch (e) {
        this.note = `Couldn't list files: ${e?.message ?? e}`;
      }
      this.busy = false;
      cx.notify();
    });
  }

  replaceAll(cx) {
    const files = this.confirm?.files ?? [], q = { ...this.q };
    this.confirm = null;
    if (!files.length) return;
    this.busy = true;
    this.remember();
    this.note = `Replacing in ${plural(files.length, "file")}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      const undo = [];
      let total = 0, failed = 0;
      for (const f of files) {
        try {
          const x = await replaceInFile(q, this.root, this.on, f.path);
          if (x.after === x.before) continue;
          await writeTextFile(x.path, x.after, x.before);
          undo.push(x);
          total += f.count;
        } catch { failed++; }
      }
      this.undo = undo.length ? undo : null;
      this.note = `Replaced ${plural(total, "match", "matches")} in ${plural(undo.length, "file")}` + (failed ? ` · ${failed} skipped (binary, too large or changed)` : "");
      this.busy = false;
      this.run(cx, true);
    });
  }

  undoLast(cx) {
    const undo = this.undo;
    if (!undo || this.busy) return;
    this.undo = null;
    this.busy = true;
    cx.spawn(async (cx) => {
      let failed = 0;
      for (const u of undo) {
        try { await writeTextFile(u.path, u.before, u.after); } catch { failed++; }
      }
      this.note = failed ? `Undone, except ${plural(failed, "file")} changed since` : "Undone";
      this.busy = false;
      this.run(cx, true);
    });
  }

  // Drawing

  render(cx) {
    const t = theme(), font = settings().font_family ?? "JetBrains Mono";
    const sel = this.selected(), re = this.regex();
    const replacing = this.showReplace && Boolean(this.q.query);

    const tog = (id, label, on, tip, fn) =>
      div().id(id).h(24).min_w(26).px(5).flex_none().rounded(5).items_center().justify_center().flex()
        .text_size(12).font_family(font).cursor_pointer()
        .text_color(on ? t.accent_foreground : t.muted).when(on, (el) => el.bg(t.accent))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => { fn(cx); cx.notify(); })
        .tooltip(tip).child(label);

    const field = (key, extra) =>
      h_flex().h(34).flex_1().min_w(0).px(10).gap(6).items_center().rounded(8).border_1()
        .border_color(this.focusAt === FIELDS.indexOf(key) ? t.accent : t.input).bg(t.background)
        .child(Input.new(this.inputs[key]).flex_1().min_w(0).h_full().text_size(13).text_color(t.foreground))
        .children(extra ?? []);

    const button = (id, label, enabled, fn, primary) =>
      div().id(id).h(30).px(12).flex_none().flex().items_center().rounded(7).text_size(12.5)
        .when(primary && enabled, (el) => el.bg(t.solid).text_color(t.solid_foreground))
        .when(!primary || !enabled, (el) => el.border_1().border_color(t.border).text_color(enabled ? t.foreground : t.dim))
        .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => { fn(cx); cx.notify(); }))
        .child(label);

    const where = this.root == null ? "finding the project…" : (this.on ? `${this.on}:` : "") + (this.root.startsWith(home()) ? "~" + this.root.slice(home().length) : this.root);
    const g = gutterWidth(Math.max(1, ...(this.results?.files ?? []).map((f) => f.lines[f.lines.length - 1]?.line ?? 1)));

    // Results: a file header, then its lines (matches bright, context dim).
    const rowEl = (r, i) => {
      if (r.kind === "file") {
        const name = r.f.path.split("/").pop(), dir = r.f.path.slice(0, -name.length).replace(/\/$/, "");
        const folded = this.collapsed.has(r.f.path);
        return h_flex().h(H.file).px(10).gap(8).items_center().border_t(i ? 1 : 0).border_color(t.border).bg(t.surface)
          .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
          .child(fileIcon(t, r.f.path))
          .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(dir))
          .child(div().flex_none().px(6).rounded(9).bg(t.raised).text_size(11).text_color(t.muted).child(String(r.f.matches.length)));
      }
      if (r.kind === "gap") {
        return h_flex().h(H.gap).pl(18).items_center().child(div().w(g + 6).flex_none().text_right().text_size(9).text_color(t.dim).child("⋯"));
      }
      const on = sel === r, text = r.l.text;
      let cut = r.indent;
      const first = r.m?.ranges[0]?.[0] ?? 0;
      if (r.m && first - cut > 60) cut = first - 24;
      const shown = (cut > r.indent ? "…" : "") + text.slice(cut);
      const shift = cut - (cut > r.indent ? 1 : 0);
      const ranges = (r.m?.ranges ?? []).map(([s, e]) => [s - shift, e - shift]);
      const found = replacing ? this.repl.get(`${r.f.path}:${r.l.line}`) : null;
      const repl = replacing && r.m ? (k) => found?.[k] : undefined;
      return h_flex().h(H.line).pl(18).pr(10).gap(10).items_center().text_size(12.5).font_family(font)
        .bg(on ? t.selected : t.background)
        .child(div().w(g + 6).flex_none().text_right().text_color(on ? t.foreground : t.dim).child(String(r.l.line)))
        .child(segments(t, shown, ranges, { repl, current: -1 }).text_color(on ? t.foreground : r.m ? t.muted : t.dim));
    };

    const list = v_virtual_list("ps-results", this.rows.length, this.rows.map((r) => H[r.kind]),
      (i) => (this.rows[i]?.kind === "file" ? `f:${this.rows[i].f.path}` : `r:${i}`),
      (range) => this.rows.slice(range.start, range.end).map((r, k) => rowEl(r, range.start + k)))
      .track_scroll(this.listScroll).size_full()
      .on_item_click((key, cx) => {
        if (key.startsWith("f:")) {
          const p = key.slice(2);
          this.collapsed.has(p) ? this.collapsed.delete(p) : this.collapsed.add(p);
          const cur = this.selected();
          this.rebuild();
          if (cur) this.sel = Math.max(0, this.matchRows.findIndex((ri) => this.rows[ri].m === cur.m));
        } else {
          const at = this.matchRows.indexOf(Number(key.slice(2)));
          if (at < 0) return;
          if (at === this.sel) return this.open();
          this.sel = at;
          this.follow(cx);
        }
        cx.notify();
      });

    // Preview: the selected match's file, its line in the middle.
    const file = sel ? this.files.get(sel.f.path) : null;
    let preview;
    if (!sel) preview = div().p(16).text_size(13).text_color(t.dim).child(this.q.query ? "" : "Type to search every file in the project.");
    else if (!file?.lines) preview = div().p(16).text_size(13).text_color(t.dim).child(file?.error ?? "Loading…");
    else {
      const lines = file.lines, pg = gutterWidth(lines.length);
      const fileHits = new Map(sel.f.matches.map((m) => [m.line, m.ranges]));
      preview = v_flex().flex_1().min_h(0).relative().pt(6).text_size(12.5)
        .child(v_virtual_list("ps-preview", lines.length, 20, (i) => `${sel.f.path}:${i}`,
          (range) => lines.slice(range.start, range.end).map((l, k) => {
            const n = range.start + k + 1;
            const ranges = fileHits.get(n) ?? (re ? rangesIn(re, l) : []);
            return codeLine(t, n, l, ranges, n === sel.m.line, font, pg);
          })).track_scroll(this.pvScroll).size_full())
        .child(Scrollbar.vertical("ps-preview").absolute().inset_0());
    }

    const count = this.results?.count ?? 0, nfiles = this.results?.files.length ?? 0;
    const summary = this.error ? this.error
      : this.loading && count ? `${count} ${count === 1 ? "match" : "matches"} in ${plural(nfiles, "file")} so far…`
      : this.loading ? "Searching…"
      : !this.q.query ? ""
      : !count ? "No matches"
      : `${count}${this.results.capped ? "+" : ""} ${count === 1 ? "match" : "matches"} in ${plural(nfiles, "file")}` + (this.results.capped ? ` · showing the first ${Math.min(count, MAX_MATCHES)}` : "");

    return v_flex().id("project-search").track_focus(this.handle).size_full().min_h(0).p(14).gap(10)
      .bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().items_center().gap(10)
        .child(div().text_size(15).font_semibold().child("Search project"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).font_family(font).child(where))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().gap(8).items_center()
        .child(field("query", [
          tog("ps-cased", "Aa", this.q.cased, "Match case (alt-c)", (cx) => this.toggle("cased", cx)),
          tog("ps-word", "ab", this.q.word, "Whole word (alt-w)", (cx) => this.toggle("word", cx)),
          tog("ps-regex", ".*", this.q.regex, "Regex (alt-r)", (cx) => this.toggle("regex", cx)),
        ]))
        .child(tog("ps-context", "≡", this.q.context, "Lines around matches (alt-x)", (cx) => this.toggle("context", cx)))
        .child(tog("ps-show-replace", "⇄", this.showReplace, "Replace (ctrl-h)", (cx) => this.toggleReplace(cx)))
        .child(tog("ps-show-filters", "⋯", this.showFilters, "Filters (alt-f)", () => this.toggleFilters())))
      .when(this.showReplace, (el) => el.child(h_flex().gap(8).items_center()
        .child(field("replace"))
        .child(button("ps-replace-one", "Replace", this.canReplace() && Boolean(sel), (cx) => this.replaceOne(cx)))
        .child(button("ps-replace-all", "Replace all", this.canReplace(), (cx) => this.askReplaceAll(cx), true))))
      .when(this.showFilters, (el) => el.child(h_flex().gap(8).items_center()
        .child(field("include"))
        .child(field("exclude"))
        .child(tog("ps-ignored", "ignored & hidden", this.q.ignored, "Also search .gitignored and hidden files (alt-i)", (cx) => this.toggle("ignored", cx)))))
      .when(Boolean(this.confirm), (el) => el.child(h_flex().gap(10).items_center().px(12).py(8).rounded(8).bg(alpha(t.blocked, 0.12)).border_1().border_color(alpha(t.blocked, 0.5))
        .child(div().flex_1().text_size(13).child(this.confirm.files.length
          ? `Replace ${plural(this.confirm.total, "match", "matches")} of “${this.q.query}” with “${this.q.replace}” in ${plural(this.confirm.files.length, "file")}?`
          : "No files to change."))
        .child(button("ps-confirm-no", "Cancel", true, () => { this.confirm = null; }))
        .when(this.confirm.files.length > 0, (el) => el.child(button("ps-confirm-yes", "Replace all  ctrl-↵", true, (cx) => this.replaceAll(cx), true)))))
      .child(h_flex().h(18).gap(10).items_center().text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.blocked : t.muted).child(summary))
        .when(Boolean(this.note), (el) => el.child(div().flex_none().text_color(t.muted).child(this.note)))
        .when(Boolean(this.undo) && !this.busy, (el) => el.child(div().id("ps-undo").flex_none().text_color(t.accent).cursor_pointer().hover((s) => s.underline())
          .on_click((_e, cx) => this.undoLast(cx)).child("Undo")))
        .when(this.showReplace && Boolean(this.on), (el) => el.child(div().flex_none().text_color(t.dim).child("Replace works on this computer's files only"))))
      .child(h_flex().flex_1().min_h(0).gap(10)
        .child(v_flex().w_2_5().min_w(0).h_full().relative().rounded(8).overflow_hidden().border_1().border_color(t.border).bg(t.background)
          .child(list)
          .child(Scrollbar.vertical("ps-results").absolute().inset_0()))
        .child(v_flex().flex_1().min_w(0).h_full().rounded(8).overflow_hidden().border_1().border_color(t.border).bg(t.background)
          .when(Boolean(sel), (el) => el.child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
            .child(fileIcon(t, sel.f.path))
            .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(font).text_color(t.muted).child(`${sel.f.path}:${sel.m.line}`))
            .child(button("ps-open", "Open ↵", true, () => this.open()))))
          .child(preview)))
      .child(h_flex().gap(14).text_size(11).text_color(t.dim)
        .child("↑↓ select").child("↵ open").child("ctrl-↑↓ history").child("ctrl-h replace · ctrl-↵ replace all")
        .child("alt-c case · alt-w word · alt-r regex · alt-x context").child("tab next field"));
  }

  key(e, cx) {
    const k = e.keystroke;
    const fields = ["query", ...(this.showReplace ? ["replace"] : []), ...(this.showFilters ? ["include", "exclude"] : [])];
    if (k === "escape") {
      if (this.confirm) this.confirm = null;
      else { this.close(); closeOverlay(props().overlay); return; }
    } else if (k === "down" || k === "ctrl-n") this.move(1, cx);
    else if (k === "up" || k === "ctrl-p") this.move(-1, cx);
    else if (k === "pagedown") this.move(10, cx);
    else if (k === "pageup") this.move(-10, cx);
    else if (k === "ctrl-up") this.recall(1, cx);
    else if (k === "ctrl-down") this.recall(-1, cx);
    else if (k === "alt-c") this.toggle("cased", cx);
    else if (k === "alt-w") this.toggle("word", cx);
    else if (k === "alt-r") this.toggle("regex", cx);
    else if (k === "alt-i") this.toggle("ignored", cx);
    else if (k === "alt-x") this.toggle("context", cx);
    else if (k === "ctrl-h") this.toggleReplace(cx);
    else if (k === "alt-f") this.toggleFilters();
    else if (k === "ctrl-enter" || k === "cmd-enter") this.secondary(cx);
    else if (k === "tab" || k === "shift-tab") {
      const cur = Math.max(0, fields.indexOf(FIELDS[this.focusAt]));
      this.inputs[fields[(cur + (k === "tab" ? 1 : fields.length - 1)) % fields.length]].focus();
    } else return;
    cx.stop_propagation();
    cx.notify();
  }
}
