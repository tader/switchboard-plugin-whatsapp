import type { PluginContext } from "./types/api.d.ts";
import { createAdapter } from "./lib/adapter.js";
export default function setup(ctx: PluginContext) {
  return createAdapter(ctx);
}
