import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Locating the transcript of one session: Paseo's config says which Claude providers exist and which config directory each has; the
// transcript is `<projects>/<project>/<sessionId>.jsonl` under that directory. Read-only, and the session id is checked before any path.

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** The Claude providers of Paseo's config in its order (`claude` and those that extend it), each with the projects folder it resumes from. */
async function roots(): Promise<string[]> {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  const providers: Record<string, any> = { claude: {}, ...config?.agents?.providers };
  return Object.entries(providers)
    .filter(([id, p]) => (id === "claude" || p?.extends === "claude") && p?.enabled !== false)
    .map(([, p]) => join(p?.env?.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"));
}

/** The transcript of `sessionId`, from the first provider that lists it. Null when no provider has it on this machine. */
export async function locate(sessionId: string): Promise<string | null> {
  if (!SESSION_FILE.test(`${sessionId}.jsonl`)) return null; // the id comes from Paseo: it may not steer a path
  for (const dir of await roots()) {
    for (const project of await readdir(dir).catch(() => [])) {
      const path = join(dir, project, `${sessionId}.jsonl`);
      const real = await realpath(path).catch(() => null);
      if (real && (await stat(real)).isFile()) return real;
    }
  }
  return null;
}
