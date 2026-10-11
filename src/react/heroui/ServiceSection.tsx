import { Button, Card, Disclosure, Tooltip } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ServiceSnapshot } from "../../types";
import { FOCUS_EVENT, groupAnchor, serviceAnchor, type FocusDetail } from "../anchors";
import { STATUS_TEXT, STATUS_TONE } from "../format";
import { servicesOf, statusOf, type Section } from "../tree";
import { ServiceRow } from "./ServiceRow";
import { TONE_BG } from "./tones";

/** Collapsed sections are a per-viewer preference, kept in localStorage when available */
function useStoredExpanded(key: string, defaultExpanded: boolean) {
  const storageKey = `sermon:section:${key}`;
  const [expanded, setExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? defaultExpanded : stored === "expanded";
    } catch {
      return defaultExpanded;
    }
  });
  const update = useCallback(
    (value: boolean) => {
      setExpanded(value);
      try {
        localStorage.setItem(storageKey, value ? "expanded" : "collapsed");
      } catch {
        // Storage unavailable (private mode…): the state just isn't remembered
      }
    },
    [storageKey]
  );
  return [expanded, update] as const;
}

/** One circle per service, colored by status; the tooltip names the service */
function ServiceDots({ services }: { services: ServiceSnapshot[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
      {services.map((service) => {
        const status = statusOf(service);
        return (
          <Tooltip key={service.key} delay={100} closeDelay={0}>
            <Tooltip.Trigger
              aria-label={`${service.name}: ${STATUS_TEXT[status]}`}
              className="flex size-4 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className={`size-2.5 rounded-full ${TONE_BG[STATUS_TONE[status]]}`} />
            </Tooltip.Trigger>
            <Tooltip.Content>{service.name}</Tooltip.Content>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** The rows of a group, then its nested groups under small headings */
function SectionBody({ section, nested = false }: { section: Section; nested?: boolean }) {
  return (
    <>
      {nested && (
        <div id={groupAnchor(section.key)} className="mt-4 scroll-mt-6">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted">{section.title}</h4>
          {section.description && <p className="text-xs text-muted">{section.description}</p>}
        </div>
      )}
      {section.services.length > 0 && (
        <div className="divide-y divide-border">
          {section.services.map((service) => (
            <ServiceRow key={service.key} service={service} />
          ))}
        </div>
      )}
      {section.groups.map((group) => (
        <SectionBody key={group.key} section={group} nested />
      ))}
    </>
  );
}

/**
 * A group of services as a collapsible card. The header shows one status circle per service,
 * so a collapsed section still shows if something is wrong.
 */
export function ServiceSection({
  section,
  defaultExpanded = false,
}: {
  section: Section;
  /** Whether the section starts open for viewers who haven't chosen (default false) */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useStoredExpanded(section.key, defaultExpanded);
  const services = useMemo(() => servicesOf(section), [section]);

  // Navigating to this section, one of its groups or one of its services opens it first
  useEffect(() => {
    const collectGroups = (s: Section): string[] => [groupAnchor(s.key), ...s.groups.flatMap(collectGroups)];
    const anchors = new Set([...collectGroups(section), ...services.map((service) => serviceAnchor(service.key))]);
    const onFocus = (event: Event) => {
      if (anchors.has((event as CustomEvent<FocusDetail>).detail.anchor)) setExpanded(true);
    };
    window.addEventListener(FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_EVENT, onFocus);
  }, [section, services, setExpanded]);

  if (!services.length) return null;

  return (
    <Card id={groupAnchor(section.key)} className="scroll-mt-6">
      <Disclosure isExpanded={expanded} onExpandedChange={setExpanded}>
        {/* The circles have their own tooltips, so they sit beside the trigger, not inside it */}
        <Disclosure.Heading className="flex items-start gap-3">
          <Disclosure.Trigger className="flex min-w-0 flex-1 cursor-pointer flex-col text-left">
            <span className="font-medium leading-snug">{section.title}</span>
            {section.description && <span className="text-sm leading-snug text-muted">{section.description}</span>}
          </Disclosure.Trigger>
          {/* Circles and chevron share one row so they stay vertically centered together */}
          <div className="-mt-1 flex max-w-[50%] items-center gap-3">
            <ServiceDots services={services} />
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className="shrink-0"
              aria-label={expanded ? `Collapse ${section.title}` : `Expand ${section.title}`}
              aria-expanded={expanded}
              onPress={() => setExpanded(!expanded)}
            >
              <Disclosure.Indicator className="text-muted" />
            </Button>
          </div>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body>
            <div className="mt-2">
              <SectionBody section={section} />
            </div>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </Card>
  );
}
