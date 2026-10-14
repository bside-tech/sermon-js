import { Card } from "@heroui/react";
import { useContext, useMemo } from "react";
import { formatDateTime } from "../format";
import { useStatusAt } from "../hooks";
import { flattenServices, sortServices, statusOf } from "../tree";
import type { HistoryPeriod } from "./HistoryBars";
import { KitOptions, ServiceRow } from "./ServiceRow";

/**
 * "What was failing" during a past period (typically the history bar a viewer selected): every
 * service that was down or degraded then, with the error and per-instance statuses recorded
 * at the time. Each service shows its worst result of the period.
 */
export function FailingServices({ period, title = "What was failing" }: { period: HistoryPeriod; title?: string }) {
  const past = useStatusAt(period);
  const options = useContext(KitOptions);
  const kit = useMemo(() => ({ ...options, historical: true }), [options]);
  const failing = useMemo(
    () =>
      sortServices(
        flattenServices(past.data?.tree ?? []).filter((service) => ["down", "degraded"].includes(statusOf(service)))
      ),
    [past.data]
  );
  // While another period loads, the previous one stays on screen: say which one is shown
  const shown = past.data?.period ?? period;

  return (
    <Card aria-busy={past.isFetching}>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        <Card.Description>
          {formatDateTime(shown.start)} – {formatDateTime(shown.end + 1)}
          {past.isFetching ? " · loading…" : ""}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {past.isError && <p className="text-sm text-danger">Could not load this period: {past.error.message}</p>}
        {past.isPending && <div className="h-16 animate-pulse rounded-lg bg-default" />}
        {past.data && failing.length === 0 && (
          <p className="text-sm text-muted">
            {past.data.period?.runs ? "Nothing was failing in this period." : "No checks ran in this period."}
          </p>
        )}
        {failing.length > 0 && (
          <KitOptions.Provider value={kit}>
            <div className={`divide-y divide-border ${past.isPlaceholderData ? "opacity-60" : ""}`}>
              {failing.map((service) => (
                // The same services are listed further down the page, which owns their anchors
                <ServiceRow key={service.key} service={service} anchor={false} />
              ))}
            </div>
          </KitOptions.Provider>
        )}
      </Card.Content>
    </Card>
  );
}
