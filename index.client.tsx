import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeBtw } from "./client/ask.tsx";

export default function contribute(client: PluginClientContext) {
  contributeBtw(client);
  return () => {};
}
