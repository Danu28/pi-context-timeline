/**
 * Pi Context Timeline — visualize how Pi builds model context.
 *
 * Shows a live timeline of: system prompt construction, user/assistant messages,
 * tool calls, context transforms, compaction/summaries, model switches, and token usage.
 *
 * Install: pi install git:github.com/Danu28/pi-context-timeline
 *   or: pi --extension ./extensions/context-timeline.ts
 * Commands: /ctx  /context-timeline  /ctx-timeline  /ctx-clear  /ctx-export  /context-timeline-help
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
const ESTIMATED_WINDOW = 128_000; // ~est; real model windows vary 128k-200k (annotated as ~)
let lastModel: string | null = null;
let lastSessionId: string | null = null;
let totalTokensIn = 0;
let totalTokensOut = 0;
let compactionCount = 0;
let seq = 0;

function uid() {
  return `${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

function estTokens(text: string): number {
  if (!text) return 0;
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
  if (timeline.length > MAX_EVENTS) {
    const dropped = timeline.length - MAX_EVENTS;
    timeline = timeline.slice(-MAX_EVENTS);
    // keep totals bounded roughly - we keep est, but note truncation
    if (dropped > 0 && e.kind !== "info") {
      // totals stay; bar is ~ anyway
    }
  }
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
  const total = timeline.length;
  // single-pass counts (was 2× filter before)
  let msgCount = 0;
  let toolCount = 0;
  for (const e of timeline) {
    if (e.kind === "user" || e.kind === "assistant") msgCount++;
    if (e.kind === "tool-call") toolCount++;
  }
  const tokIn = totalTokensIn;
  const tokOut = totalTokensOut;
  const win = ESTIMATED_WINDOW;
  const used = tokIn + tokOut;
  const pct = Math.min(100, Math.round((used / win) * 100));
  const barLen = 10;
  const filled = Math.round((pct / 100) * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
  const status = `◷ ${total} | 💬${msgCount} | 🔧${toolCount} | ${bar} ~${pct}% ${tokIn + tokOut > 0 ? `(${fmtK(tokIn)}/${fmtK(tokOut)})` : ""}${compactionCount ? ` ✂${compactionCount}` : ""}`;
  try {
    (ctx.ui as any).setStatus?.("context-timeline", status);
  } catch {}
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n % 1000 === 0) return `${n/1000}k`;
  return `${(n / 1000).toFixed(1)}k`;
}

function summarizeSystemPrompt(opts: any): string {
  const parts: string[] = [];
  if (!opts) return "system prompt (no opts)";
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

// sanitize export filename: no traversal, only .json, inside cwd
function sanitizeExportName(input: string, fallback: string): string {
  const raw = (input || fallback).trim();
  // strip directory components - keep only basename
  const base = raw.split(/[\\/]/).pop() || fallback;
  // allow only safe chars, force .json
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || fallback;
  return safe.endsWith(".json") ? safe : `${safe}.json`;
}

function safeJoinCwd(name: string): string {
  // name is already sanitized basename, so join is safe
  // still verify resolved stays inside cwd
  // dynamic import to avoid top-level side effects
  return name; // resolved by caller with path.join, basename guarantees safety
}

// ── Timeline UI Component ────────────────────────────────────────────────────

function makeTimelineComponent(done: (v: unknown) => void, theme: any, tui: any) {
  let scroll = 0;
  let selected = timeline.length - 1;
  let expanded = new Set<string>();
  let showHelp = false;
  let filter: Kind | null = null;

  const allKinds: Kind[] = ["system", "user", "assistant", "tool-call", "tool-result", "context", "compaction", "model", "session", "turn", "info"];

  function visible(): TimelineEvent[] {
    if (!filter) return timeline;
    return timeline.filter(e => e.kind === filter);
  }

  function clamp() {
    const v = visible();
    if (selected < 0) selected = 0;
    if (selected >= v.length) selected = Math.max(0, v.length - 1);
    if (scroll < 0) scroll = 0;
  }

  const c = {
    accent: (s: string) => { try { return theme.fg("accent", s); } catch { return s; } },
    dim: (s: string) => { try { return theme.fg("dim", s); } catch { return s; } },
    muted: (s: string) => { try { return theme.fg("muted", s); } catch { return s; } },
    success: (s: string) => { try { return theme.fg("success", s); } catch { return s; } },
    warning: (s: string) => { try { return theme.fg("warning", s); } catch { return s; } },
    error: (s: string) => { try { return theme.fg("error", s); } catch { return s; } },
    text: (s: string) => s,
  };

  function kindIcon(k: Kind): string {
    switch (k) {
      case "session": return "●";
      case "system": return "⬢";
      case "user": return "▶";
      case "assistant": return "◆";
      case "tool-call": return "◈";
      case "tool-result": return "↳";
      case "context": return "⇄";
      case "compaction": return "✂";
      case "model": return "⬣";
      case "turn": return "─";
      case "info": return "·";
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
      case "context": return c.accent(s);
      case "compaction": return c.warning(s);
      case "model": return c.muted(s);
      case "session": return c.accent(s);
      case "turn": return c.dim(s);
      default: return c.dim(s);
    }
  }

  function truncate(s: string, w: number): string {
    if (w <= 0) return "";
    // use Array.from for unicode-aware slicing
    const arr = Array.from(s);
    if (arr.length <= w) return s;
    return arr.slice(0, Math.max(0, w - 1)).join("") + "…";
  }

  function stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }

  const comp: any = {
    handleInput(data: string) {
      const v = visible();
      if (data === "\x1b" || data === "q" || data === "\x03") { done(null); return; }
      if (data === "?" ) { showHelp = !showHelp; tui.requestRender(); return; }
      if (data === "c" || data === "C") {
        timeline = [];
        totalTokensIn = 0; totalTokensOut = 0; compactionCount = 0;
        expanded.clear(); selected = 0; scroll = 0;
        push({ kind: "info", label: "Timeline cleared", detail: "Cleared by user" });
        tui.requestRender(); return;
      }
      if (data === "e" || data === "E") {
        // async export - fire and notify
        (async () => {
          try {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const safeName = sanitizeExportName(`context-timeline-${Date.now()}.json`, "context-timeline.json");
            const p = path.join(process.cwd(), safeName);
            const payload = { exportedAt: new Date().toISOString(), model: lastModel, totals: { in: totalTokensIn, out: totalTokensOut, compactions: compactionCount }, timeline };
            await fs.promises.writeFile(p, JSON.stringify(payload, null, 2), "utf8");
            push({ kind: "info", label: `Exported to ${safeName}`, detail: `${timeline.length} events → ${p}` });
          } catch (e: any) {
            push({ kind: "info", label: "Export failed", detail: String(e?.message ?? e) });
          }
          tui.requestRender();
        })();
        return;
      }
      if (data === "f") {
        if (!filter) filter = allKinds[0]!;
        else {
          const idx = allKinds.indexOf(filter);
          filter = idx >= allKinds.length - 1 ? null : allKinds[idx + 1]!;
        }
        selected = 0; scroll = 0;
        tui.requestRender(); return;
      }
      // Esc when filtered clears filter first
      if (data === "\x1b" && filter) { filter = null; tui.requestRender(); return; }
      if (data === "\r" || data === "\n" || data === " " ) {
        const cur = v[selected];
        if (cur) {
          if (expanded.has(cur.id)) expanded.delete(cur.id);
          else expanded.add(cur.id);
          tui.requestRender();
        }
        return;
      }
      if (data === "\x1b[A" || data === "k" || data === "K") {
        selected = Math.max(0, selected - 1);
        if (selected < scroll) scroll = selected;
        tui.requestRender(); return;
      }
      if (data === "\x1b[B" || data === "j" || data === "J") {
        selected = Math.min(v.length - 1, selected + 1);
        tui.requestRender(); return;
      }
      if (data === "g") { selected = 0; scroll = 0; tui.requestRender(); return; }
      if (data === "G") { selected = v.length - 1; tui.requestRender(); return; }
      if (data === "\x1b[5~" ) {
        selected = Math.max(0, selected - 10);
        scroll = Math.max(0, scroll - 10);
        tui.requestRender(); return;
      }
      if (data === "\x1b[6~" ) {
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
      const totalTok = totalTokensIn + totalTokensOut;
      const pct = Math.min(100, Math.round((totalTok / ESTIMATED_WINDOW) * 100));
      const barLen = Math.min(24, Math.max(10, width - 60));
      const filled = Math.round((pct / 100) * barLen);
      const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
      const pctColor = pct > 85 ? c.error : pct > 65 ? c.warning : c.dim;

      lines.push(c.accent("┌─ Pi Context Timeline ─────────────────────────────────────────────┐"));
      const summary = ` ${totalTok ? `${fmtK(totalTokensIn)} in / ${fmtK(totalTokensOut)} out` : "no tokens yet"} · ${timeline.length} events${compactionCount ? ` · ${compactionCount} compaction` : ""} · ${lastModel ?? "no model"}`;
      const barStr = pctColor(` ${bar} ~${pct}% `);
      const avail = Math.max(0, width - 2);
      let sumLine = summary;
      const barPlain = stripAnsi(barStr);
      if (sumLine.length + barPlain.length + 4 > avail) {
        sumLine = truncate(sumLine, avail - barPlain.length - 4);
      }
      lines.push(`│${sumLine}${" ".repeat(Math.max(1, avail - (sumLine.length + barPlain.length)))}${barStr}│`);
      const legend = filter
        ? c.warning(` filter: ${filter}  (f cycle, Esc clear) `)
        : c.dim(" legend: ⬢system ▶user ◆assistant ◈tool ⇄context ✂compact  (f=filter ?=help) ");
      const legendPlain = stripAnsi(legend);
      lines.push(`│${(legendPlain.length > avail ? truncate(stripAnsi(legend), avail-1) : legend).padEnd(avail)}│`);
      lines.push(c.dim("├" + "─".repeat(Math.max(0, width-2)) + "┤"));

      if (v.length === 0) {
        const msg = filter ? `No events for filter "${filter}"` : "No events yet — send a message or run a tool to build the timeline.";
        lines.push(`│ ${c.dim(msg).padEnd(avail-1)}│`);
        lines.push(c.dim("└" + "─".repeat(Math.max(0, width-2)) + "┘"));
        lines.push(c.dim("  q/Esc close  │  f filter  │  c clear  │  e export  │  ? help"));
        return lines;
      }

      // adaptive viewport based on width-provided; approximate but better than hardcoded 18
      const viewportRows = Math.max(8, Math.min(30, Math.floor((width > 80 ? 22 : 16))));
      if (selected < scroll) scroll = selected;
      if (selected >= scroll + viewportRows) scroll = selected - viewportRows + 1;
      const start = Math.max(0, Math.min(scroll, v.length - viewportRows));
      const end = Math.min(v.length, start + viewportRows);

      for (let i = start; i < end; i++) {
        const ev = v[i]!;
        const isSel = i === selected;
        const isExp = expanded.has(ev.id);
        const prefix = isSel ? c.accent("▸") : " ";
        const icon = kindColor(ev.kind, kindIcon(ev.kind));
        const time = c.dim(fmtTime(ev.ts));
        const tok = ev.tokensEst ? c.dim(` ~${fmtK(ev.tokensEst)}t`) : "";
        const meta = ev.meta ? c.dim(` · ${truncate(ev.meta, 24)}`) : "";
        const left = `${prefix} ${icon} ${time} `;
        const label = isSel ? (()=>{ try{return theme.fg("accent", ev.label);}catch{return ev.label;}})() : ev.label;
        const right = `${tok}${meta}`;
        const leftPlain = stripAnsi(left);
        const rightPlain = stripAnsi(right);
        const rowAvail = Math.max(0, avail - leftPlain.length - rightPlain.length - 2);
        let row = `│${left}${truncate(label, rowAvail)}${" ".repeat(Math.max(1, rowAvail - truncate(label, rowAvail).length))}${right} │`;
        if (isSel) { try { row = (theme as any).bg ? (theme as any).bg("selectedBg", row) : (theme as any).inverse(row); } catch { try { row = theme.inverse(row); } catch {} } }
        lines.push(row);
        if (isExp) {
          const det = ev.detail || "(no detail)";
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
        lines.push(c.dim("   1) System prompt: instructions + tools + skills"));
        lines.push(c.dim("   2) Conversation: user ↔ assistant messages"));
        lines.push(c.dim("   3) Tools: results appended to next context"));
        lines.push(c.dim("   4) Context transform: extensions may edit messages"));
        lines.push(c.dim("   5) Compaction: old turns summarized when ~window fills"));
        lines.push(c.dim("   6) Token bar is ~est (128k est); real limit varies by model"));
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
  if (w <= 0) return [""];
  const out: string[] = [];
  const words = s.split(/(\s+)/);
  let cur = "";
  for (const wd of words) {
    if (!wd) continue;
    if ((cur + wd).length > w) {
      if (cur) out.push(cur);
      if (wd.length > w) {
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
    const sid: string | undefined = (ctx as any).sessionId ?? (_ev as any).sessionId;
    const isNewSession = sid !== lastSessionId;
    if (sid) lastSessionId = sid;
    if (timeline.length === 0) {
      push({ kind: "session", label: "Session started", detail: `Session ${String(sid ?? "").slice(0, 8)} · cwd: ${String(process.cwd()).split(/[\\/]/).pop() ?? process.cwd()}`, meta: (ctx as any).mode ?? "" });
      push({ kind: "info", label: "How context works", detail: "System prompt (instructions+tools+skills) + conversation + tool results = context. When ~window fills, Pi compacts old turns. Use /ctx to view." });
    } else if (isNewSession) {
      push({ kind: "session", label: "Session resumed", detail: `Resumed · ${timeline.length} prior events (session ${String(sid ?? "").slice(0,8)})` });
    }
    if ((ctx as any).model) lastModel = `${(ctx as any).model.provider}/${(ctx as any).model.id}`;
    updateWidget();
  });

  pi.on("session_shutdown", async () => {
    currentCtx = null;
    if (widgetTimer) { clearTimeout(widgetTimer); widgetTimer = null; }
    try { (currentCtx as any)?.ui?.setStatus?.("context-timeline", ""); } catch {}
  });

  pi.on("model_select", async (ev: any, _ctx) => {
    lastModel = `${ev.model.provider}/${ev.model.id}`;
    const prev = ev.previousModel ? `${ev.previousModel.provider}/${ev.previousModel.id}` : "none";
    push({ kind: "model", label: `Model → ${lastModel}`, detail: `${prev} → ${lastModel} · source: ${ev.source ?? "unknown"}`, meta: ev.source });
    updateWidget();
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
      label: `System prompt · ${msgCount} msgs`,
      detail: sysSummary + (sysText ? `\n— preview —\n${sysText.slice(0, 600)}${sysText.length > 600 ? "…" : ""}` : "") + (msgs.length ? `\nMessages: ${msgs.slice(0,3).map((m:any)=>m.role).join(", ")}${msgs.length>3 ? ` +${msgs.length-3} more` : ""}` : ""),
      tokensEst: tokEst,
      meta: lastModel ?? undefined,
    });
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
    push({ kind: "context", label: `Context transform · ${before} msgs`, detail: `A context handler ran. This is where extensions can trim/reorder/inject messages before the model sees them. If no handler returned a value, context is unchanged.`, meta: `in: ${before}` });
  });

  pi.on("message_start", async (_ev: any) => {
    push({ kind: "info", label: "Assistant streaming…", detail: `Model ${lastModel ?? ""} started generating`, meta: "stream" });
  });

  pi.on("message_end", async (ev: any) => {
    const msg = ev.message ?? ev;
    const role = msg.role ?? "assistant";
    const rawContent: any = (msg as any).content;
    const content = typeof rawContent === "string" ? rawContent : Array.isArray(rawContent) ? rawContent.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n") : "";
    const usage = msg.usage ?? ev.usage;
    const tokEst = usage ? (usage.input ?? 0) + (usage.output ?? 0) : estTokens(content);
    push({
      kind: role === "user" ? "user" : "assistant",
      label: role === "assistant"
        ? (content.slice(0, 80).replace(/\n/g, " ") || `(assistant · ${msg.stopReason ?? "stop"})`) + (content.length>80?"…":"")
        : content.slice(0,80),
      detail: content ? content.slice(0, 3000) + (content.length>3000 ? "\n… (truncated)" : "") : JSON.stringify(msg).slice(0, 1200),
      tokensEst: tokEst || estTokens(content) || undefined,
      meta: usage ? `${usage.input ?? "?"}↑ ${usage.output ?? "?"}↓${usage.cost ? ` $${usage.cost.total?.toFixed?.(4) ?? ""}` : ""}` : msg.stopReason,
    });
  });

  pi.on("tool_call", async (ev: ToolCallEvent) => {
    const name = (ev as any).toolName ?? (ev as any).name ?? "tool";
    const input = (ev as any).input ?? (ev as any).args ?? {};
    const preview = JSON.stringify(input).slice(0, 300);
    push({ kind: "tool-call", label: `tool: ${name}`, detail: preview || "(no args)", tokensEst: estTokens(preview) || undefined, meta: name });
  });

  pi.on("tool_result", async (ev: ToolResultEvent) => {
    const name = (ev as any).toolName ?? (ev as any).name ?? "tool";
    const res: any = (ev as any).result ?? ev;
    const text = res?.content?.[0]?.text ?? res?.text ?? JSON.stringify(res).slice(0, 600);
    const isErr = res?.isError || (ev as any).isError;
    push({ kind: "tool-result", label: `${isErr ? "✗" : "✓"} ${name} result`, detail: String(text).slice(0, 2000), tokensEst: estTokens(String(text)) || undefined, meta: isErr ? "error" : "ok" });
  });

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
    if (u) push({ kind: "info", label: `Agent run end`, detail: `usage: ${u.input ?? "?"} in / ${u.output ?? "?"} out`, tokensEst: (u.input ?? 0) + (u.output ?? 0) || undefined, meta: "agent_end" });
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
    updateWidget();
  });
  pi.on("session_compact_failed" as any, async (ev: any) => {
    push({ kind: "info", label: "Compaction failed", detail: String(ev.error ?? ev.reason ?? "unknown").slice(0, 800), meta: "error" });
  });

  async function openTimeline(ctx: ExtensionContext) {
    if ((ctx as any).mode !== "tui") {
      ctx.ui.notify("Context timeline requires interactive TUI mode", "error");
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
    description: "Export timeline to JSON file (safe basename, .json only)",
    handler: async (args, ctx) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const safeName = sanitizeExportName(args.trim() || `context-timeline-${Date.now()}.json`, `context-timeline-${Date.now()}.json`);
      const p = path.join(process.cwd(), safeName);
      const payload = { exportedAt: new Date().toISOString(), model: lastModel, totals: { in: totalTokensIn, out: totalTokensOut, compactions: compactionCount }, timeline };
      await fs.promises.writeFile(p, JSON.stringify(payload, null, 2), "utf8");
      ctx.ui.notify(`Exported ${timeline.length} events → ${p}`, "info");
    },
  });

  pi.registerCommand("context-timeline-help", {
    description: "Explain how Pi context works",
    handler: async (_args, ctx) => {
      const msg = [
        "## How Pi Context Works",
        "",
        "Every model request sends a context = system prompt + conversation + tool results.",
        "",
        "1. System prompt — built from before_agent_start (instructions, tools, skills, project context).",
        "2. Messages — alternating user / assistant turns.",
        "3. Tool results — outputs appended as context for next turn.",
        "4. Context transforms — extensions may edit messages before model sees them.",
        "5. Token window — model max varies (e.g. 128k~200k); bar shows ~est.",
        "6. Compaction — Pi summarizes old turns when ~window fills.",
        "",
        "Open live view with /ctx",
      ].join("\n");
      push({ kind: "info", label: "Context help viewed", detail: msg.slice(0, 1200) });
      if ((ctx as any).mode === "tui" && (ctx.ui as any).notify) {
        await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
          return {
            handleInput(d: string) { if (d === "\x1b" || d === "q" || d === "\r" ) done(null); },
            render(w: number) {
              const lines = msg.split("\n").map(l => { try{return theme.fg("dim", l.slice(0, w-2));}catch{return l;}});
              return [(()=>{try{return theme.fg("accent","┌─ How Pi Context Works ─┐");}catch{return "How Pi Context Works";}})(), ...lines.map(l=> "│ "+l), (()=>{try{return theme.fg("dim","└" + "─".repeat(Math.max(0,w-2))+"┘");}catch{return "";}})(), "  q/Esc to close"];
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
