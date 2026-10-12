/**
 * Pi Context Timeline — visualize how Pi builds model context.
 *
 * Shows a live timeline of: system prompt construction, user/assistant messages,
 * tool calls, context transforms, compaction/summaries, model switches, and token usage.
 *
 * Install: put this folder in ~/.pi/agent/extensions/  or  pi --extension ./context-timeline
 * Commands: /ctx  /context-timeline  /ctx-timeline  /ctx-clear  /ctx-export
 *
 * Hooks: session_start, before_agent_start, context, message_start/end,
 *        tool_call, tool_result, tool_execution_*, turn_end, agent_end,
 *        agent_settled, model_select, session_before_compact, session_compact
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  ContextEvent,
  ToolCallEvent,
  ToolResultEvent,
  SessionStartEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

type Kind =
  | "session"
  | "system"
  | "user"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "context"
  | "compaction"
  | "model"
  | "turn"
  | "info";

interface TimelineEvent {
  id: string;
  ts: number;
  kind: Kind;
  label: string;
  detail: string;
  tokensEst?: number;
  meta?: string;
}

let timeline: TimelineEvent[] = [];
const MAX_EVENTS = 600;
let lastModel: string | null = null;
let totalTokensIn = 0;
let totalTokensOut = 0;
let compactionCount = 0;
let seq = 0;

function uid() {
  return `${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

function estTokens(text: string): number {
  if (!text) return 0;
  // rough: ~4 chars per token
  return Math.ceil(text.length / 4);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function push(ev: Omit<TimelineEvent, "id" | "ts"> & { ts?: number }) {
  const e: TimelineEvent = {
    id: uid(),
    ts: ev.ts ?? Date.now(),
    kind: ev.kind,
    label: ev.label,
    detail: ev.detail,
    tokensEst: ev.tokensEst,
    meta: ev.meta,
  };
  timeline.push(e);
  if (timeline.length > MAX_EVENTS) timeline = timeline.slice(-MAX_EVENTS);
  // ring: keep totals bounded
  if (e.tokensEst) {
    if (e.kind === "user" || e.kind === "system" || e.kind === "context") totalTokensIn += e.tokensEst;
    if (e.kind === "assistant") totalTokensOut += e.tokensEst;
  }
  if (e.kind === "compaction") compactionCount++;
  scheduleWidgetUpdate();
}

let widgetTimer: ReturnType<typeof setTimeout> | null = null;
let currentCtx: ExtensionContext | null = null;

function scheduleWidgetUpdate() {
  if (widgetTimer) return;
  widgetTimer = setTimeout(() => {
    widgetTimer = null;
    try { updateWidget(); } catch {}
  }, 80);
}

function updateWidget() {
  if (!currentCtx) return;
  const ctx = currentCtx;
  // prefer setStatus (lightweight) + try setWidget if available
  const total = timeline.length;
  const msgCount = timeline.filter(e => e.kind === "user" || e.kind === "assistant").length;
  const toolCount = timeline.filter(e => e.kind === "tool-call").length;
  const tokIn = totalTokensIn;
  const tokOut = totalTokensOut;
  // crude context window estimate: 128k, warn at 80%
  const win = 128_000;
  const used = tokIn + tokOut;
  const pct = Math.min(100, Math.round((used / win) * 100));
  const barLen = 10;
  const filled = Math.round((pct / 100) * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
  const status = `◷ ${total}·💬${msgCount}·🔧${toolCount}·${bar} ${pct}% ${tokIn + tokOut > 0 ? `(${fmtK(tokIn)}/${fmtK(tokOut)})` : ""}${compactionCount ? ` ✂${compactionCount}` : ""}`;
  try {
    // setStatus is always available; widget adds more detail if supported
    (ctx.ui as any).setStatus?.("context-timeline", status);
  } catch {}
  try {
    const w = (ctx.ui as any).setWidget;
    if (typeof w === "function") {
      // some Pi versions expose setWidget(id, factory)
    }
  } catch {}
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + "k";
}

function summarizeSystemPrompt(opts: any): string {
  const parts: string[] = [];
  if (!opts) return "system prompt (no opts)";
  // opts is BuildSystemPromptOptions / NormalizedBuildSystemPromptOptions
  if (opts.sections) {
    const secs = Array.isArray(opts.sections) ? opts.sections : Object.entries(opts.sections);
    parts.push(`sections: ${secs.length}`);
    for (const s of secs.slice(0, 4) as any[]) {
      const name = typeof s === "string" ? s : (s.name ?? s.id ?? s.title ?? JSON.stringify(s).slice(0, 40));
      parts.push(` • ${name}`);
    }
    if (secs.length > 4) parts.push(` + ${secs.length - 4} more`);
  }
  if (opts.tools) parts.push(`tools: ${Array.isArray(opts.tools) ? opts.tools.length : Object.keys(opts.tools).length}`);
  if (opts.guidelines) parts.push(`guidelines: ${Array.isArray(opts.guidelines) ? opts.guidelines.length : 1}`);
  if (opts.skillList) parts.push(`skills: ${Array.isArray(opts.skillList) ? opts.skillList.length : 1}`);
  return parts.join("  ");
}

// ── Timeline UI Component ────────────────────────────────────────────────────

function makeTimelineComponent(done: (v: unknown) => void, theme: any, tui: any) {
  let scroll = 0;
  let selected = timeline.length - 1;
  let expanded = new Set<string>();
  let showHelp = false;
  let filter: Kind | null = null;

  const kinds: Kind[] = ["system", "user", "assistant", "tool-call", "tool-result", "context", "compaction"];

  function visible(): TimelineEvent[] {
    if (!filter) return timeline;
    return timeline.filter(e => e.kind === filter || (filter === "tool-call" && e.kind === "tool-result"));
  }

  function clamp() {
    const v = visible();
    if (selected < 0) selected = 0;
    if (selected >= v.length) selected = Math.max(0, v.length - 1);
    if (scroll < 0) scroll = 0;
  }

  // color helpers
  const c = {
    accent: (s: string) => theme.fg("accent", s),
    dim: (s: string) => theme.fg("dim", s),
    muted: (s: string) => theme.fg("muted", s),
    success: (s: string) => theme.fg("success", s),
    warning: (s: string) => theme.fg("warning", s),
    error: (s: string) => theme.fg("error", s),
    text: (s: string) => s,
  };

  function kindIcon(k: Kind): string {
    switch (k) {
      case "session": return "●";
      case "system": return "⬢";
      case "user": return "▶";
      case "assistant": return "◆";
      case "tool-call": return "🔧";
      case "tool-result": return "↳";
      case "context": return "⇄";
      case "compaction": return "✂";
      case "model": return "🤖";
      case "turn": return "─";
      case "info": return "ℹ";
      default: return "·";
    }
  }

  function kindColor(k: Kind, s: string): string {
    switch (k) {
      case "system": return c.accent(s);
      case "user": return c.success(s);
      case "assistant": return c.text(s);
      case "tool-call": return c.warning(s);
      case "tool-result": return c.dim(s);
      case "context": return theme.fg("accent", s); // cyan-ish via accent
      case "compaction": return theme.fg("warning", s);
      case "model": return c.muted(s);
      case "session": return c.accent(s);
      case "turn": return c.dim(s);
      default: return c.dim(s);
    }
  }

  function truncate(s: string, w: number): string {
    // simple slice; theme helpers would be better but avoid import fragility
    if (s.length <= w) return s;
    return s.slice(0, Math.max(0, w - 1)) + "…";
  }

  const comp: any = {
    handleInput(data: string) {
      const v = visible();
      // handle escape sequences: arrow keys come as \x1b[A etc
      if (data === "\x1b" || data === "q" || data === "\x03") { done(null); return; } // Esc / q / ctrl-c
      if (data === "?" ) { showHelp = !showHelp; tui.requestRender(); return; }
      if (data === "c" || data === "C") {
        timeline = [];
        totalTokensIn = 0; totalTokensOut = 0; compactionCount = 0;
        expanded.clear(); selected = 0; scroll = 0;
        push({ kind: "info", label: "Timeline cleared", detail: "Cleared by user" });
        tui.requestRender(); return;
      }
      if (data === "e" || data === "E") {
        try {
          const p = `./context-timeline-${Date.now()}.json`;
          const fs = require("node:fs");
          fs.writeFileSync(p, JSON.stringify({ exportedAt: new Date().toISOString(), timeline }, null, 2));
          push({ kind: "info", label: `Exported to ${p}`, detail: `${timeline.length} events` });
        } catch (e: any) {
          push({ kind: "info", label: "Export failed", detail: String(e?.message ?? e) });
        }
        tui.requestRender(); return;
      }
      // filter cycle: f
      if (data === "f") {
        if (!filter) filter = "user";
        else {
          const idx = kinds.indexOf(filter);
          filter = idx >= kinds.length - 1 ? null : kinds[idx + 1]!;
        }
        selected = 0; scroll = 0;
        tui.requestRender(); return;
      }
      if (data === "\r" || data === "\n" || data === " " ) {
        const cur = v[selected];
        if (cur) {
          if (expanded.has(cur.id)) expanded.delete(cur.id);
          else expanded.add(cur.id);
          tui.requestRender();
        }
        return;
      }
      // navigation
      if (data === "\x1b[A" || data === "k" || data === "K") { // up
        selected = Math.max(0, selected - 1);
        if (selected < scroll) scroll = selected;
        tui.requestRender(); return;
      }
      if (data === "\x1b[B" || data === "j" || data === "J") { // down
        selected = Math.min(v.length - 1, selected + 1);
        // viewport approx handled in render
        tui.requestRender(); return;
      }
      if (data === "g") { selected = 0; scroll = 0; tui.requestRender(); return; }
      if (data === "G") { selected = v.length - 1; tui.requestRender(); return; }
      if (data === "\x1b[5~" ) { // page up
        selected = Math.max(0, selected - 10);
        scroll = Math.max(0, scroll - 10);
        tui.requestRender(); return;
      }
      if (data === "\x1b[6~" ) { // page down
        selected = Math.min(v.length - 1, selected + 10);
        tui.requestRender(); return;
      }
      if (data === "\x1b[H" || data === "\x1b[1~") { selected = 0; scroll = 0; tui.requestRender(); return; }
      if (data === "\x1b[F" || data === "\x1b[4~") { selected = v.length - 1; tui.requestRender(); return; }
    },
    render(width: number): string[] {
      clamp();
      const v = visible();
      const lines: string[] = [];
      const headerH = 4;
      const footerH = 3;
      // reserve header+footer when computing viewport, but render will just output all lines (ScrollView handles it)
      // We simulate scroll window
      const totalTok = totalTokensIn + totalTokensOut;
      const pct = Math.min(100, Math.round((totalTok / 128000) * 100));
      const barLen = Math.min(24, Math.max(10, width - 60));
      const filled = Math.round((pct / 100) * barLen);
      const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
      const pctColor = pct > 85 ? c.error : pct > 65 ? c.warning : c.dim;

      lines.push(c.accent("┌─ Pi Context Timeline ─────────────────────────────────────────────┐"));
      // summary line
      const summary = ` ${totalTok ? `${fmtK(totalTokensIn)} in / ${fmtK(totalTokensOut)} out` : "no tokens yet"} · ${timeline.length} events${compactionCount ? ` · ${compactionCount} compaction` : ""} · ${lastModel ?? "no model"}`;
      const barStr = pctColor(` ${bar} ${pct}% `);
      // pad
      const avail = Math.max(0, width - 2);
      let sumLine = summary;
      if (sumLine.length + barStr.replace(/\x1b\[[0-9;]*m/g, "").length + 4 > avail) {
        // truncate summary if needed
        sumLine = truncate(sumLine, avail - barStr.replace(/\x1b\[[0-9;]*m/g, "").length - 4);
      }
      lines.push(`│${sumLine}${" ".repeat(Math.max(1, avail - (sumLine.length + barStr.replace(/\x1b\[[0-9;]*m/g,"").length)))} ${barStr}│`);
      // legend
      const legend = filter
        ? c.warning(` filter: ${filter}  (f to cycle, Esc to clear filter) `)
        : c.dim(" legend: ⬢system ▶user ◆assistant 🔧tool ⇄context ✂compact  (f=filter ?=help) ");
      lines.push(`│${truncate(legend.replace(/\x1b\[[0-9;]*m/g,"").length > avail ? truncate(legend, avail-1) : legend, avail).padEnd(avail)}│`);
      lines.push(c.dim("├" + "─".repeat(Math.max(0, width-2)) + "┤"));

      if (v.length === 0) {
        const msg = filter ? `No events for filter "${filter}"` : "No events yet — send a message or run a tool to build the timeline.";
        lines.push(`│ ${c.dim(msg).padEnd(avail-1)}│`);
        lines.push(c.dim("└" + "─".repeat(Math.max(0, width-2)) + "┘"));
        lines.push(c.dim("  q/Esc close  │  f filter  │  c clear  │  e export  │  ? help"));
        return lines;
      }

      // scroll window: keep selected visible
      const viewportRows = 18; // approximate visible rows for timeline body
      if (selected < scroll) scroll = selected;
      if (selected >= scroll + viewportRows) scroll = selected - viewportRows + 1;
      const start = Math.max(0, Math.min(scroll, v.length - viewportRows));
      const end = Math.min(v.length, start + viewportRows);

      // column widths
      const timeW = 10;

      for (let i = start; i < end; i++) {
        const ev = v[i]!;
        const isSel = i === selected;
        const isExp = expanded.has(ev.id);
        const prefix = isSel ? c.accent("▸") : " ";
        const icon = kindColor(ev.kind, kindIcon(ev.kind));
        const time = c.dim(fmtTime(ev.ts));
        const tok = ev.tokensEst ? c.dim(` ~${fmtK(ev.tokensEst)}t`) : "";
        const meta = ev.meta ? c.dim(` · ${truncate(ev.meta, 24)}`) : "";
        // main row
        const left = `${prefix} ${icon} ${time} `;
        const label = isSel ? theme.fg("accent", ev.label) : ev.label;
        const right = `${tok}${meta}`;
        const rowAvail = Math.max(0, avail - left.replace(/\x1b\[[0-9;]*m/g,"").length - right.replace(/\x1b\[[0-9;]*m/g,"").length - 2);
        let row = `│${left}${truncate(label, rowAvail)}${" ".repeat(Math.max(1, rowAvail - truncate(label, rowAvail).length))}${right} │`;
        // selected row background hint
        if (isSel) { try { row = theme.bg("selectedBg", row); } catch { try { row = theme.inverse(row); } catch {} } }
        lines.push(row);
        // detail line when expanded or for compact single-line detail
        if (isExp) {
          const det = ev.detail || "(no detail)";
          // wrap detail into width
          const detLines = wrap(det, avail - 6);
          for (const dl of detLines.slice(0, 6)) {
            lines.push(`│   ${c.dim("│")} ${c.dim(truncate(dl, avail - 6)).padEnd(avail-6)} │`);
          }
          if (detLines.length > 6) {
            lines.push(`│   ${c.dim("… +" + (detLines.length - 6) + " more lines")}`.padEnd(avail+10) + " │");
          }
        } else if (ev.detail) {
          const one = truncate(ev.detail.replace(/\n/g, " · ").slice(0, avail - 6), avail - 6);
          lines.push(`│   ${c.dim(one.padEnd(avail-6))} │`);
        }
      }

      // overflow indicator
      if (v.length > viewportRows) {
        const pos = ` ${end}/${v.length} `;
        const moreTop = start > 0 ? c.dim(`↑ ${start} above`) : "";
        const moreBot = end < v.length ? c.dim(`↓ ${v.length - end} below`) : "";
        const mid = [moreTop, pos, moreBot].filter(Boolean).join(c.dim(" · "));
        lines.push(`│${mid.padEnd(avail)}│`);
      }

      lines.push(c.dim("└" + "─".repeat(Math.max(0, width-2)) + "┘"));

      if (showHelp) {
        lines.push(c.accent("  Help — how Pi context works:"));
        lines.push(c.dim("   1) System prompt: model instructions + guidelines + tool defs + skills"));
        lines.push(c.dim("   2) Conversation: user ↔ assistant messages (history)"));
        lines.push(c.dim("   3) Tools: model calls tools → results are appended to context"));
        lines.push(c.dim("   4) Context transform: extensions may edit context before the model sees it"));
        lines.push(c.dim("   5) Compaction/summary: old turns summarized when window fills"));
        lines.push(c.dim("   6) Token window: model has a max (e.g. 128k–200k); bar shows ~usage"));
        lines.push("");
      }
      lines.push(c.dim("  ↑/↓ or j/k move  ·  Enter expand  ·  g/G top/bottom  ·  f filter  ·  c clear  ·  e export  ·  q close  ·  ? help"));
      return lines;
    },
    invalidate() {},
  };
  return comp;
}

function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  const words = s.split(/(\s+)/);
  let cur = "";
  for (const wd of words) {
    if ((cur + wd).length > w) {
      if (cur) out.push(cur);
      if (wd.length > w) {
        // hard break long token
        for (let i = 0; i < wd.length; i += w) out.push(wd.slice(i, i + w));
        cur = "";
      } else cur = wd.trimStart();
    } else cur += wd;
  }
  if (cur) out.push(cur);
  return out.length ? out : [s.slice(0, w)];
}

// ── Extension factory ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_ev: SessionStartEvent, ctx) => {
    currentCtx = ctx as unknown as ExtensionContext;
    if (timeline.length === 0) {
      push({ kind: "session", label: "Session started", detail: `Session ${(_ev as any).sessionId?.slice(0, 8) ?? ""} · cwd: ${process.cwd()}`, meta: (ctx as any).mode ?? "" });
      push({ kind: "info", label: "How context works", detail: "System prompt (instructions+tools+skills) + conversation history + tool results = context sent to model. When the window fills, Pi compacts old turns into a summary. Use /ctx to open the timeline." });
    } else {
      push({ kind: "session", label: "Session resumed", detail: `Resumed with ${timeline.length} prior events` });
    }
    if (ctx.model) lastModel = `${ctx.model.provider}/${ctx.model.id}`;
    updateWidget();
  });

  pi.on("session_shutdown", async () => {
    currentCtx = null;
    if (widgetTimer) { clearTimeout(widgetTimer); widgetTimer = null; }
  });

  pi.on("model_select", async (ev: any, ctx) => {
    lastModel = `${ev.model.provider}/${ev.model.id}`;
    const prev = ev.previousModel ? `${ev.previousModel.provider}/${ev.previousModel.id}` : "none";
    push({ kind: "model", label: `Model → ${lastModel}`, detail: `${prev} → ${lastModel} · source: ${ev.source ?? "unknown"}`, meta: ev.source });
    updateWidget();
    ctx.ui.notify?.(`Context-Timeline: model ${lastModel}`, "info");
  });

  pi.on("before_agent_start", async (ev: BeforeAgentStartEvent, _ctx) => {
    const opts: any = (ev as any).systemPromptOptions ?? (ev as any).options ?? (ev as any).promptOptions;
    const msgs: any[] = (ev as any).messages ?? (ev as any).prompt?.messages ?? [];
    const sysSummary = summarizeSystemPrompt(opts);
    const msgCount = msgs.length;
    const sysText = typeof (ev as any).systemPrompt === "string" ? (ev as any).systemPrompt : "";
    const tokEst = estTokens(sysText || sysSummary) + estTokens(JSON.stringify(msgs).slice(0, 8000));
    push({
      kind: "system",
      label: `System prompt built · ${msgCount} msgs`,
      detail: sysSummary + (sysText ? `\n— preview —\n${sysText.slice(0, 600)}${sysText.length > 600 ? "…" : ""}` : "") + (msgs.length ? `\nMessages: ${msgs.slice(0,3).map((m:any)=>m.role).join(", ")}${msgs.length>3 ? ` +${msgs.length-3} more` : ""}` : ""),
      tokensEst: tokEst,
      meta: lastModel ?? undefined,
    });
    // also capture last user message if present
    const lastUser = [...msgs].reverse().find((m: any) => m.role === "user");
    if (lastUser) {
      const raw = (lastUser as any).content;
      const text = (typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n") : "").slice(0, 800) || JSON.stringify(lastUser).slice(0, 500);
      if (text) {
        push({ kind: "user", label: text.slice(0, 80).replace(/\n/g, " ") + (text.length>80?"…":""), detail: text, tokensEst: estTokens(text) });
      }
    }
  });

  pi.on("context", async (ev: ContextEvent) => {
    const before = (ev as any).messages?.length ?? (ev as any).context?.length ?? 0;
    // handlers can return { messages } to transform
    // we just log that a transform occurred; detail is limited
    push({ kind: "context", label: `Context transform · ${before} msgs`, detail: `A context handler ran. This is where extensions can trim, reorder, or inject messages before the model sees them. If no handler returned a value, context is unchanged.`, meta: `in: ${before}` });
  });

  pi.on("message_start", async (_ev: any) => {
    // streaming start — lightweight
    push({ kind: "info", label: "Assistant streaming…", detail: `Model ${lastModel ?? ""} started generating`, meta: "stream" });
  });

  pi.on("message_end", async (ev: any) => {
    const msg = ev.message ?? ev;
    const role = msg.role ?? "assistant";
    const rawContent: any = (msg as any).content;
    const content = typeof rawContent === "string" ? rawContent : Array.isArray(rawContent) ? rawContent.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n") : "";
    const usage = msg.usage ?? ev.usage;
    const tokIn = usage?.input ?? estTokens(content);
    const tokOut = usage?.output ?? 0;
    if (usage) { totalTokensIn += usage.input ?? 0; totalTokensOut += usage.output ?? 0; }
    push({
      kind: role === "user" ? "user" : "assistant",
      label: role === "assistant"
        ? (content.slice(0, 80).replace(/\n/g, " ") || `(assistant · ${msg.stopReason ?? "stop"})`) + (content.length>80?"…":"")
        : content.slice(0,80),
      detail: content ? content.slice(0, 3000) + (content.length>3000 ? "\n… (truncated)" : "") : JSON.stringify(msg).slice(0, 1200),
      tokensEst: tokIn + tokOut || estTokens(content),
      meta: usage ? `${usage.input ?? "?"}↑ ${usage.output ?? "?"}↓${usage.cost ? ` $${usage.cost.total?.toFixed?.(4) ?? ""}` : ""}` : msg.stopReason,
    });
  });

  pi.on("tool_call", async (ev: ToolCallEvent) => {
    const name = (ev as any).toolName ?? (ev as any).name ?? "tool";
    const input = (ev as any).input ?? (ev as any).args ?? {};
    const preview = JSON.stringify(input).slice(0, 300);
    push({ kind: "tool-call", label: `tool: ${name}`, detail: preview || "(no args)", tokensEst: estTokens(preview), meta: name });
  });

  pi.on("tool_result", async (ev: ToolResultEvent) => {
    const name = (ev as any).toolName ?? (ev as any).name ?? "tool";
    const res: any = (ev as any).result ?? ev;
    const text = res?.content?.[0]?.text ?? res?.text ?? JSON.stringify(res).slice(0, 600);
    const isErr = res?.isError || (ev as any).isError;
    push({ kind: "tool-result", label: `${isErr ? "✗" : "✓"} ${name} result`, detail: String(text).slice(0, 2000), tokensEst: estTokens(String(text)), meta: isErr ? "error" : "ok" });
  });

  // also tool_execution_* for streaming tool feedback
  pi.on("tool_execution_start" as any, async (ev: any) => {
    push({ kind: "info", label: `tool exec start: ${ev.toolName ?? ev.name ?? "tool"}`, detail: JSON.stringify(ev.input ?? ev.args ?? {}).slice(0, 400), meta: "exec" });
  });
  pi.on("tool_execution_end" as any, async (ev: any) => {
    const ok = !ev.error;
    push({ kind: "info", label: `tool exec end: ${ev.toolName ?? ev.name ?? "tool"} ${ok?"✓":"✗"}`, detail: ev.error ? String(ev.error).slice(0, 800) : `duration ${ev.durationMs ?? "?"}ms`, meta: ok ? "done" : "error" });
  });

  pi.on("turn_end", async (_ev: any) => {
    const t: any = _ev;
    push({ kind: "turn", label: "Turn end", detail: t.reason ? `reason: ${t.reason}` : "Agent turn completed — context now includes all new messages + tool results", meta: t.reason ?? "" });
  });

  pi.on("agent_end", async (_ev: any) => {
    const u = (_ev as any).usage ?? (_ev as any).result?.usage;
    if (u) push({ kind: "info", label: `Agent run end`, detail: `usage: ${u.input ?? "?"} in / ${u.output ?? "?"} out`, tokensEst: (u.input ?? 0) + (u.output ?? 0), meta: "agent_end" });
    else push({ kind: "info", label: "Agent run end", detail: "Run finished; may continue with compaction or follow-ups", meta: "agent_end" });
    updateWidget();
  });

  pi.on("agent_settled", async () => {
    push({ kind: "info", label: "Agent settled — waiting for user", detail: "No more automatic continuations; context is stable until next user message", meta: "settled" });
    updateWidget();
  });

  pi.on("session_before_compact" as any, async (ev: any) => {
    const prep = ev.preparation ?? ev;
    push({ kind: "compaction", label: `Compaction triggered · ${prep.tokensBefore?.toLocaleString?.() ?? "?"} tokens`, detail: `messagesToSummarize: ${prep.messagesToSummarize?.length ?? "?"}, turnPrefix: ${prep.turnPrefixMessages?.length ?? "?"}, firstKept: ${String(prep.firstKeptEntryId ?? "").slice(0,8)}`, tokensEst: prep.tokensBefore, meta: "before_compact" });
  });
  pi.on("session_compact" as any, async (ev: SessionCompactEvent) => {
    const e: any = ev;
    push({ kind: "compaction", label: `Compacted → summary ${String(e.compactionId ?? "").slice(0,8)}`, detail: (e.summary ?? e.compaction?.summary ?? "").slice(0, 1200) || "Summary created; old turns replaced", tokensEst: e.tokensBefore ?? e.compaction?.tokensBefore, meta: "compact" });
    compactionCount++;
    updateWidget();
  });
  pi.on("session_compact_failed" as any, async (ev: any) => {
    push({ kind: "info", label: "Compaction failed", detail: String(ev.error ?? ev.reason ?? "unknown").slice(0, 800), meta: "error" });
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  async function openTimeline(ctx: ExtensionContext) {
    if ((ctx as any).mode !== "tui") {
      ctx.ui.notify("Context timeline requires interactive TUI mode", "error");
      // fallback: dump to console
      console.log("\n=== Pi Context Timeline ===");
      for (const e of timeline.slice(-40)) {
        console.log(`[${fmtTime(e.ts)}] ${e.kind} — ${e.label} ${e.tokensEst ? `(${e.tokensEst}t)` : ""}`);
        if (e.detail) console.log(`  ${e.detail.slice(0, 200)}`);
      }
      return;
    }
    await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
      return makeTimelineComponent(done, theme, tui);
    }, { overlay: true, overlayOptions: { width: "92%", maxHeight: "92%", anchor: "center" } } as any);
  }

  pi.registerCommand("context-timeline", {
    description: "Open interactive context timeline (how Pi builds model context)",
    handler: async (_args, ctx) => openTimeline(ctx as unknown as ExtensionContext),
  });
  pi.registerCommand("ctx-timeline", {
    description: "Alias for /context-timeline",
    handler: async (_args, ctx) => openTimeline(ctx as unknown as ExtensionContext),
  });
  pi.registerCommand("ctx", {
    description: "Alias for /context-timeline — visualize Pi context",
    handler: async (_args, ctx) => openTimeline(ctx as unknown as ExtensionContext),
  });

  pi.registerCommand("ctx-clear", {
    description: "Clear the context timeline",
    handler: async (_args, ctx) => {
      timeline = []; totalTokensIn = 0; totalTokensOut = 0; compactionCount = 0;
      push({ kind: "info", label: "Timeline cleared", detail: "Cleared via /ctx-clear" });
      ctx.ui.notify("Context timeline cleared", "info");
      updateWidget();
    },
  });

  pi.registerCommand("ctx-export", {
    description: "Export timeline to JSON file",
    handler: async (args, ctx) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const name = args.trim() || `context-timeline-${Date.now()}.json`;
      const p = path.isAbsolute(name) ? name : path.join(process.cwd(), name);
      const payload = { exportedAt: new Date().toISOString(), model: lastModel, totals: { in: totalTokensIn, out: totalTokensOut, compactions: compactionCount }, timeline };
      fs.writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");
      ctx.ui.notify(`Exported ${timeline.length} events → ${p}`, "info");
    },
  });

  pi.registerCommand("context-timeline-help", {
    description: "Explain how Pi context works",
    handler: async (_args, ctx) => {
      const msg = [
        "## How Pi Context Works",
        "",
        "Every model request sends a **context** = system prompt + conversation history + tool results.",
        "",
        "1. **System prompt** — built from `before_agent_start` (`systemPromptOptions`): core instructions, guidelines, available tools, skills, project context.",
        "2. **Messages** — alternating user / assistant turns. Assistant messages may contain tool calls.",
        "3. **Tool results** — after tools run, their outputs are appended as `tool_result` messages and become part of next context.",
        "4. **Context transforms** — extensions can edit context via the `context` event before it reaches the model.",
        "5. **Token window** — each model has a max (e.g. 128k–200k tokens). The status bar shows ~usage.",
        "6. **Compaction** — when context grows too large, Pi summarizes old turns (`session_before_compact` → `session_compact`) and keeps the summary + recent turns.",
        "",
        "Open the live view with **/ctx** — it shows each step as a timeline so you can see what the model actually sees.",
      ].join("\n");
      // show as notification + log; also push to timeline
      push({ kind: "info", label: "Context help viewed", detail: msg.slice(0, 1200) });
      if ((ctx as any).mode === "tui" && (ctx.ui as any).notify) {
        // also render via custom overlay for readability
        await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
          return {
            handleInput(d: string) { if (d === "\x1b" || d === "q" || d === "\r" ) done(null); },
            render(w: number) {
              const lines = msg.split("\n").map(l => theme.fg("dim", l.slice(0, w-2)));
              return [theme.fg("accent", "┌─ How Pi Context Works ─┐"), ...lines.map(l=> "│ "+l), theme.fg("dim","└" + "─".repeat(Math.max(0,w-2))+"┘"), theme.fg("dim","  q/Esc to close")];
            },
            invalidate(){}
          };
        }, { overlay: true, overlayOptions: { width: "86%", maxHeight: "80%", anchor: "center" } } as any);
      } else {
        console.log(msg);
      }
    },
  });
}
