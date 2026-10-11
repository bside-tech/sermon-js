import type { ServiceSnapshot, SnapshotNode, Status, StatusSnapshot } from "../types";

const STATUS_ORDER: Record<Status, number> = { down: 0, degraded: 1, up: 2, sleeping: 3, unconfigured: 4 };

/** The status to show for a service: its latest result, or "unconfigured" */
export const statusOf = (service: ServiceSnapshot): Status =>
  service.configured ? (service.result?.status ?? "unconfigured") : "unconfigured";

/** Failing first, then critical, then by name */
export function sortServices(services: ServiceSnapshot[]): ServiceSnapshot[] {
  return [...services].sort(
    (a, b) =>
      STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)] ||
      Number(b.critical) - Number(a.critical) ||
      a.name.localeCompare(b.name)
  );
}

/** Every service of a tree, in declaration order */
export function flattenServices(nodes: SnapshotNode[]): ServiceSnapshot[] {
  return nodes.flatMap((node) => (node.type === "service" ? [node] : flattenServices(node.children)));
}

/** A group ready to render: its own services, sorted, and its nested groups */
export type Section = {
  key: string;
  title: string;
  description?: string;
  services: ServiceSnapshot[];
  groups: Section[];
};

/** A page is a list of blocks: sections (cards), or a heading introducing several sections */
export type LayoutBlock =
  | { type: "section"; section: Section }
  | { type: "heading"; key: string; title: string; description?: string; sections: Section[] };

function toSection(node: Extract<SnapshotNode, { type: "group" }>): Section {
  return {
    key: node.key,
    title: node.title,
    description: node.description,
    services: sortServices(node.children.filter((child): child is ServiceSnapshot => child.type === "service")),
    groups: node.children
      .filter((child): child is Extract<SnapshotNode, { type: "group" }> => child.type === "group")
      .map(toSection),
  };
}

/**
 * Turn the snapshot tree into page blocks:
 * - a top-level group with services of its own is one section
 * - a top-level group that only contains groups is a heading, followed by one section per group
 * - services outside any group are gathered into a section titled `ungroupedTitle`
 */
export function buildLayout(
  tree: StatusSnapshot["tree"],
  { ungroupedTitle = "Services" }: { ungroupedTitle?: string } = {}
): LayoutBlock[] {
  const blocks: LayoutBlock[] = [];
  let loose: ServiceSnapshot[] = [];
  let looseCount = 0;
  const flushLoose = () => {
    if (!loose.length) return;
    looseCount += 1;
    blocks.push({
      type: "section",
      section: {
        key: looseCount === 1 ? "ungrouped" : `ungrouped-${looseCount}`,
        title: ungroupedTitle,
        services: sortServices(loose),
        groups: [],
      },
    });
    loose = [];
  };

  for (const node of tree) {
    if (node.type === "service") {
      loose.push(node);
      continue;
    }
    flushLoose();
    const section = toSection(node);
    if (section.services.length === 0 && section.groups.length > 0) {
      blocks.push({
        type: "heading",
        key: section.key,
        title: section.title,
        description: section.description,
        sections: section.groups,
      });
    } else {
      blocks.push({ type: "section", section });
    }
  }
  flushLoose();
  return blocks;
}

/** Every service of a section, including its nested groups */
export function servicesOf(section: Section): ServiceSnapshot[] {
  return [...section.services, ...section.groups.flatMap(servicesOf)];
}

/** Every section of a layout, flattened (headings contribute their sections) */
export function sectionsOf(blocks: LayoutBlock[]): Section[] {
  return blocks.flatMap((block) => (block.type === "section" ? [block.section] : block.sections));
}

/** True when the last full run is older than twice the interval: the scheduler probably stopped */
export function isStale(snapshot: Pick<StatusSnapshot, "lastRunAt" | "intervalMs">, now = Date.now()): boolean {
  return snapshot.lastRunAt !== null && now - snapshot.lastRunAt > 2 * snapshot.intervalMs;
}
