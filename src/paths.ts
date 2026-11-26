import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HOSTS, type HostDefinition, type HostId, type HostScope, type HomeOverride } from "./hosts.ts";
import { realPath } from "./platform.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ResolveHostPathsOptions {
  env: Environment;
  home: string;
  workspaceRoot?: string;
  hosts?: readonly HostId[];
  /** The existing setup tools write user options by default. Project files are opt-in. */
  scopes?: readonly HostScope[];
  /** Older setup tools can select the literal override, without the managed-profile redirect. */
  redirectManagedProfiles?: boolean;
}

export interface HostRedirect {
  target: HostId;
  from: string;
  to: string;
  reason: string;
}

export interface HostPaths {
  home: string;
  paths: Partial<Record<HostId, string[]>>;
  /** Pre-redirect paths for validating receipts from older setup versions. */
  legacyPaths: Partial<Record<HostId, string[]>>;
  redirects: HostRedirect[];
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realPath(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

function orcaHome(root: string, kind: "claude" | "codex", orcaRoot: string): boolean {
  const parts = relative(canonical(orcaRoot), canonical(root)).split(sep);
  return kind === "claude"
    ? parts.length === 3 && parts[0] === "claude-profiles" && !!parts[1] && parts[2] === "home"
    : parts.length === 3 && parts[0] === "codex-accounts" && !!parts[1] && parts[2] === "home"
      || parts.length === 2 && parts[0] === "codex-runtime-home" && parts[1] === "home";
}

function configRoot(override: HomeOverride, env: Environment, home: string): string {
  const { directory, key, rule } = override;
  const setting = env[key];
  const fallback = join(home, directory);
  if (rule === "absolute-only") return setting && isAbsolute(setting) ? resolve(setting) : fallback;
  const present = rule === "empty-means-set" ? setting !== undefined : rule === "expand-tilde" ? !!setting : !!setting?.trim();
  if (!present || setting === undefined) return fallback;
  const expanded = rule === "expand-tilde" && /^~(?:[/\\]|$)/.test(setting)
    ? join(home, ...setting.slice(2).split(/[/\\]/))
    : setting;
  const given = resolve(expanded);
  const withinHome = relative(resolve(env.HOME?.trim() || home), given);
  return withinHome !== ".." && !withinHome.startsWith(".." + sep) && !isAbsolute(withinHome) ? join(home, withinHome) : given;
}

/** Resolve MCP paths, without opening configuration files. Publishers still guard the selected paths. */
export function resolveHostPaths(options: ResolveHostPathsOptions): HostPaths {
  const { env, home, workspaceRoot, hosts, scopes = ["user"], redirectManagedProfiles = true } = options;
  const paths: HostPaths["paths"] = {};
  const legacyPaths: HostPaths["legacyPaths"] = {};
  const redirects: HostRedirect[] = [];
  for (const target of new Set(hosts ?? (Object.keys(HOSTS) as HostId[]))) {
    const host: HostDefinition = HOSTS[target];
    const current: string[] = [];
    const legacy: string[] = [];
    for (const file of host.files) {
      if (!scopes.includes(file.scope)) continue;
      const base = file.scope === "project" ? workspaceRoot : home;
      if (base === undefined) continue;
      const root = file.override ? configRoot(file.override, env, base) : base;
      const from = join(root, file.path);
      legacy.push(from);
      const personal = file.personalSource;
      if (redirectManagedProfiles && personal) {
        const orcaRoot = env[personal.orcaHomeVariable]?.trim() || join(home, "Library", "Application Support", "orca");
        const to = join(home, file.override?.directory ?? "", file.path);
        if (from !== to && orcaHome(root, personal.profile, orcaRoot)) {
          current.push(to);
          redirects.push({ target, from, to, reason: "Orca re-syncs this managed file from the personal source" });
          continue;
        }
      }
      current.push(from);
    }
    paths[target] = current;
    legacyPaths[target] = legacy;
  }
  return { home, paths, legacyPaths, redirects };
}
