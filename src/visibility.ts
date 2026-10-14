import type {
  HistoryPayload,
  ServiceSnapshot,
  SnapshotNode,
  Status,
  StatusSnapshot,
} from "./types";

/**
 * What a viewer may see. "full" is everything; "public" is the essentials: the overall score,
 * the history chart, and one status per top-level group, without individual services,
 * providers, errors, timings, machines or usage.
 */
export type View = "full" | "public";

/** Title of the component that gathers services declared outside any group */
export const UNGROUPED_COMPONENT = { key: "ungrouped", title: "Other services" };

type ServiceLike = { status: Status | undefined; critical: boolean };

/**
 * The status of a group as one component: down when a critical service is down (or every
 * checked service is), degraded when anything else is wrong, up when something answered or
 * sleeps as expected, and unconfigured when nothing in it was checked.
 */
export function componentStatus(services: ServiceLike[]): Status {
  const checked = services.filter((service) => service.status && service.status !== "unconfigured");
  if (!checked.length) return "unconfigured";
  const down = checked.filter((service) => service.status === "down");
  if (down.some((service) => service.critical) || down.length === checked.length) return "down";
  if (down.length || checked.some((service) => service.status === "degraded")) return "degraded";
  return "up";
}

const servicesIn = (nodes: SnapshotNode[]): ServiceSnapshot[] =>
  nodes.flatMap((node) => (node.type === "service" ? [node] : servicesIn(node.children)));

/** Top-level components of a tree: each top-level group, plus one for loose services */
function components(tree: SnapshotNode[]) {
  const list: Array<{ key: string; title: string; description?: string; services: ServiceSnapshot[] }> = [];
  const loose: ServiceSnapshot[] = [];
  for (const node of tree) {
    if (node.type === "group") list.push({ key: node.key, title: node.title, description: node.description, services: servicesIn(node.children) });
    else loose.push(node);
  }
  if (loose.length) list.push({ ...UNGROUPED_COMPONENT, services: loose });
  return list;
}

/** Which component (top-level group key) each service belongs to */
export function componentOf(tree: SnapshotNode[]): Record<string, string> {
  return Object.fromEntries(components(tree).flatMap((component) => component.services.map((service) => [service.key, component.key])));
}

/**
 * The essentials of a snapshot for anonymous viewers: the same score, history position and
 * period, but the tree is reduced to one row per top-level group (as a service of kind
 * "group"), with only its status. Nothing about individual services is left.
 */
export function toPublicSnapshot(snapshot: StatusSnapshot): StatusSnapshot {
  const rows: ServiceSnapshot[] = components(snapshot.tree).map((component) => {
    const status = componentStatus(
      component.services.map((service) => ({
        status: service.configured ? service.result?.status : "unconfigured",
        critical: service.critical,
      }))
    );
    const checkedAts = component.services.map((service) => service.result?.checkedAt ?? 0);
    return {
      type: "service",
      key: component.key,
      kind: "group",
      name: component.title,
      description: component.description,
      critical: false,
      slowMs: 0,
      configured: status !== "unconfigured",
      result: status === "unconfigured" ? undefined : { key: component.key, status, checkedAt: Math.max(...checkedAts), probed: false },
    };
  });
  const counts: Record<Status, number> = { up: 0, degraded: 0, down: 0, sleeping: 0, unconfigured: 0 };
  for (const row of rows) counts[row.result?.status ?? "unconfigured"] += 1;
  return {
    schemaVersion: snapshot.schemaVersion,
    view: "public",
    generatedAt: snapshot.generatedAt,
    lastCheckedAt: snapshot.lastCheckedAt,
    lastRunAt: snapshot.lastRunAt,
    lastRunTrigger: snapshot.lastRunTrigger,
    nextDueAt: snapshot.nextDueAt,
    intervalMs: snapshot.intervalMs,
    retentionMs: snapshot.retentionMs,
    score: snapshot.score,
    label: snapshot.label,
    counts,
    tree: rows,
    period: snapshot.period,
  };
}

/**
 * History for anonymous viewers: each bar names the components that were failing instead of
 * the services. A component is "down" in a bar when one of its critical services was.
 */
export function toPublicHistory(history: HistoryPayload, tree: SnapshotNode[]): HistoryPayload {
  const owner = componentOf(tree);
  const critical = new Set(servicesIn(tree).filter((service) => service.critical).map((service) => service.key));
  return {
    ...history,
    bars: history.bars.map((bar) => {
      const failing: Record<string, Status> = {};
      for (const [key, status] of Object.entries(bar.failing)) {
        const component = owner[key];
        if (!component) continue;
        const level: Status = status === "down" && critical.has(key) ? "down" : "degraded";
        if (failing[component] !== "down") failing[component] = level;
      }
      return { ...bar, failing };
    }),
  };
}
