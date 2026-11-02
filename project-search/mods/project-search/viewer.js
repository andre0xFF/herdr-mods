// The viewer pane: a file opened from the search, at the match's line, with every
// match highlighted. n / shift-n step through matches; it reloads when the file changes.

import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { theme, settings, props, readTextFile, watchFolder, home, run } from "herdr";
import { toRegExp, rangesIn, codeLine, gutterWidth } from "./lib.js";
import { fileIcon } from "./icons.js";

export class FileViewer {
  init(cx) {
    const p = props();
    this.p = p;
    this.path = `${p.root}/${p.file}`;
    this.line = p.line ?? 1;
    try { this.re = p.search?.query ? toRegExp(p.search) : null; } catch { this.re = null; }
    this.lines = null; this.error = null; this.hits = []; this.ranges = new Map();
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.load(cx, true);
    if (!p.on) {
      const dir = this.path.slice(0, this.path.lastIndexOf("/"));
      cx.spawn(async (cx) => {
        for (;;) {
          const changed = await watchFolder(dir);
          if (changed.some((c) => c === this.path)) this.load(cx, false);
        }
      });
    }
  }

  load(cx, jump) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.path, { on: this.p.on });
        if (text == null) { this.error = "This file is no longer there"; this.lines = null; }
        else {
          this.error = null;
          this.lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
          this.ranges = new Map(); this.hits = [];
          this.lines.forEach((l, i) => {
            const r = rangesIn(this.re, l);
            if (r.length) { this.ranges.set(i + 1, r); this.hits.push(i + 1); }
          });
          this.line = Math.min(this.line, this.lines.length);
          if (jump) this.scroll.scroll_to_item(this.line - 1, "center");
        }
      } catch {
        this.error = "Can't show this file (too large or unreadable)";
      }
      cx.notify();
    });
  }

  step(by) {
    if (!this.hits.length) return;
    let i;
    if (by > 0) i = this.hits.findIndex((n) => n > this.line), i = i < 0 ? 0 : i;
    else { i = this.hits.length - 1; while (i >= 0 && this.hits[i] >= this.line) i--; if (i < 0) i = this.hits.length - 1; }
    this.line = this.hits[i];
    this.scroll.scroll_to_item(this.line - 1, "center");
  }

  render(cx) {
    const t = theme(), font = settings().font_family ?? "JetBrains Mono";
    const shown = (this.p.on ? `${this.p.on}:` : "") + (this.path.startsWith(home()) ? "~" + this.path.slice(home().length) : this.path);
    const at = this.hits.indexOf(this.line);
    const nav = (id, label, by) => div().id(id).w(24).h(22).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.step(by); cx.notify(); }).child(label);

    let body;
    if (!this.lines) body = div().p(16).text_color(t.dim).child(this.error ?? "Loading…");
    else {
      const g = gutterWidth(this.lines.length);
      body = v_flex().flex_1().min_h(0).relative().pt(4).text_size(12.5)
        .child(v_virtual_list("pv-lines", this.lines.length, 20, (i) => String(i + 1),
          (range) => this.lines.slice(range.start, range.end).map((l, k) => {
            const n = range.start + k + 1;
            return codeLine(t, n, l, this.ranges.get(n) ?? [], n === this.line, font, g);
          })).track_scroll(this.scroll).size_full()
          .on_item_click((key, cx) => { this.line = Number(key); cx.notify(); }))
        .child(Scrollbar.vertical("pv-lines").absolute().inset_0());
    }

    return v_flex().id("pv").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "n" || k === "f3" || k === "down" && e.modifiers.alt) this.step(1);
        else if (k === "shift-n" || k === "shift-f3" || k === "up" && e.modifiers.alt) this.step(-1);
        else if (k === "r") this.load(cx, false);
        else if (k === "g") this.scroll.scroll_to_item(this.line - 1, "center");
        else if (k === "/") run("mod.open", { name: "project-search" });
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
        .child(fileIcon(t, this.path))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(font).text_color(t.muted).child(`${shown}:${this.line}`))
        .when(this.hits.length > 0, (el) => el
          .child(div().text_size(11.5).text_color(t.dim).child(at >= 0 ? `${at + 1} of ${this.hits.length}` : `${this.hits.length} matches`))
          .child(nav("pv-prev", "↑", -1))
          .child(nav("pv-next", "↓", 1))))
      .child(body);
  }
}
