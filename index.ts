// Shim for `pi --extension ./context-timeline` — delegates to canonical entry
// Package discovery uses extensions/context-timeline.ts only (see package.json pi.extensions)
export { default } from "./extensions/context-timeline.ts";
export * from "./extensions/context-timeline.ts";
