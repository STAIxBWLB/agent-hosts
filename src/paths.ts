import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HOSTS, type HostDefinition, type HostId, type HostScope, type HomeOverride } from "./hosts.ts";
import { realPath } from "./platform.ts";
import type { RefusalCode } from "./refusal.ts";

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

export interface HostRefusal {
  host: HostId;
  code: RefusalCode;
  variable?: string;
  file?: string;
  reason: string;
}

export interface HostPaths {
  home: string;
  paths: Partial<Record<HostId, string[]>>;
  /** Pre-redirect paths for validating receipts from older setup versions. */
  legacyPaths: Partial<Record<HostId, string[]>>;
  redirects: HostRedirect[];
  roots: Partial<Record<HostId, { current: string[]; legacy: string[] }>>;
  refusals: HostRefusal[];
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

function configRoot(override: HomeOverride, env: Environment, home: string): string | Omit<HostRefusal, "host"> {
  const { directory, key, rule } = override;
  const setting = rule === "trim-presence" ? env[key]?.trim() : env[key];
  if (setting === undefined) return join(home, directory);
  if (setting === "") {
    return rule === "empty-means-set"
      ? { code: "empty-override", variable: key, reason: `${key} is set but empty; unset it or supply an absolute directory` }
      : join(home, directory);
  }
  const expanded = rule === "expand-tilde" && /^~(?:[/\\]|$)/.test(setting)
    ? join(home, ...setting.slice(2).split(/[/\\]/))
    : setting;
  if (!isAbsolute(expanded)) {
    return { code: "relative-override", variable: key, reason: `${key} is relative; unset it or supply an absolute directory` };
  }
  const given = resolve(expanded);
  if (rule === "absolute-only") return given;
  const withinHome = relative(resolve(env.HOME?.trim() || home), given);
  return withinHome !== ".." && !withinHome.startsWith(".." + sep) && !isAbsolute(withinHome) ? join(home, withinHome) : given;
}

export function openCodeRouteReason(variable: string, file: string): string {
  return `${variable} routes OpenCode away from ${file}; unset it and resolve paths again before applying`;
}

/** Resolve MCP paths, without opening configuration files. Publishers still guard the selected paths. */
export function resolveHostPaths(options: ResolveHostPathsOptions): HostPaths {
  const { env, home, workspaceRoot, hosts, scopes = ["user"], redirectManagedProfiles = true } = options;
  const paths: HostPaths["paths"] = {};
  const legacyPaths: HostPaths["legacyPaths"] = {};
  const redirects: HostRedirect[] = [];
  const roots: HostPaths["roots"] = {};
  const refusals: HostRefusal[] = [];
  for (const target of new Set(hosts ?? (Object.keys(HOSTS) as HostId[]))) {
    const host: HostDefinition = HOSTS[target];
    const firstRefusal = refusals.length;
    const current: string[] = [];
    const legacy: string[] = [];
    const currentRoots: string[] = [], legacyRoots: string[] = [];
    for (const file of host.files) {
      if (!scopes.includes(file.scope)) continue;
      const base = file.scope === "project" ? workspaceRoot : home;
      if (base === undefined) continue;
      const root = file.override ? configRoot(file.override, env, base) : base;
      if (typeof root !== "string") {
        refusals.push({ host: target, ...root });
        continue;
      }
      const from = join(root, file.path);
      for (const variable of file.routeVariables ?? []) {
        if (env[variable]?.trim()) {
          refusals.push({
            host: target, code: "opencode-config-route", variable, file: from,
            reason: openCodeRouteReason(variable, from),
          });
        }
      }
      legacy.push(from);
      const siblingRoot = file.defaultSiblingRoot && file.override && !env[file.override.key]?.trim()
        ? join(base, file.defaultSiblingRoot)
        : dirname(from);
      legacyRoots.push(siblingRoot);
      const personal = file.personalSource;
      if (redirectManagedProfiles && personal) {
        const orcaRoot = env[personal.orcaHomeVariable]?.trim() || join(home, "Library", "Application Support", "orca");
        const to = join(home, file.override?.directory ?? "", file.path);
        if (from !== to && orcaHome(root, personal.profile, orcaRoot)) {
          current.push(to);
          currentRoots.push(file.defaultSiblingRoot ? join(home, file.defaultSiblingRoot) : dirname(to));
          redirects.push({ target, from, to, reason: "Orca re-syncs this managed file from the personal source" });
          continue;
        }
      }
      current.push(from);
      currentRoots.push(siblingRoot);
    }
    if (!current.length && refusals.length !== firstRefusal) continue;
    paths[target] = current;
    legacyPaths[target] = legacy;
    roots[target] = { current: currentRoots, legacy: legacyRoots };
  }
  return { home, paths, legacyPaths, redirects, refusals, roots };
}
