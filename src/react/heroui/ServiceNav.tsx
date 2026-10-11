import { Card } from "@heroui/react";
import type { ReactNode } from "react";
import { focusAnchor, groupAnchor, serviceAnchor } from "../anchors";
import { STATUS_TEXT, STATUS_TONE } from "../format";
import { servicesOf, statusOf, type LayoutBlock, type Section } from "../tree";
import { TONE_BG } from "./tones";

function NavLink({
  anchor,
  className,
  children,
  label,
}: {
  anchor: string;
  className: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <a
      href={`#${encodeURIComponent(anchor)}`}
      aria-label={label}
      className={className}
      onClick={(event) => {
        // Let the browser handle "open in new tab/window"
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        focusAnchor(anchor);
      }}
    >
      {children}
    </a>
  );
}

function SectionLinks({ section }: { section: Section }) {
  return (
    <li>
      <NavLink
        anchor={groupAnchor(section.key)}
        className="block rounded px-1.5 pt-1 text-[11px] leading-4 font-medium text-muted hover:text-foreground"
      >
        {section.title}
      </NavLink>
      <ul>
        {servicesOf(section).map((service) => {
          const status = statusOf(service);
          return (
            <li key={service.key}>
              <NavLink
                anchor={serviceAnchor(service.key)}
                label={`${service.name}: ${STATUS_TEXT[status]}`}
                className="flex items-center gap-1.5 rounded px-1.5 text-xs leading-[18px] hover:bg-default"
              >
                <span className={`size-1.5 shrink-0 rounded-full ${TONE_BG[STATUS_TONE[status]]}`} aria-hidden />
                <span className="truncate">{service.name}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** A compact index of every service with its status, linking to its place on the page */
export function ServiceNav({ blocks, title = "Services" }: { blocks: LayoutBlock[]; title?: string }) {
  return (
    <Card className="max-h-[calc(100vh-2rem)] gap-1 overflow-y-auto p-3">
      <Card.Header>
        <Card.Title className="px-1.5 text-xs font-semibold">{title}</Card.Title>
      </Card.Header>
      <Card.Content>
        <nav aria-label="Tracked services">
          <ul className="flex flex-col gap-0.5">
            {blocks.map((block) =>
              block.type === "section" ? (
                <SectionLinks key={block.section.key} section={block.section} />
              ) : (
                <li key={block.key}>
                  <p className="mt-2 px-1.5 text-[10px] leading-4 font-semibold uppercase tracking-wide text-muted">
                    {block.title}
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {block.sections.map((section) => (
                      <SectionLinks key={section.key} section={section} />
                    ))}
                  </ul>
                </li>
              )
            )}
          </ul>
        </nav>
      </Card.Content>
    </Card>
  );
}
