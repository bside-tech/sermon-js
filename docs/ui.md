# React UI kit

Two layers, so you can take as much as you want:

- **`sermon-js/react`**: headless. An API client, React Query hooks, layout helpers, deep
  links and theme preference. Build any UI on it, with any component library.
- **`sermon-js/react/heroui`**: ready-made components on [HeroUI v3](https://heroui.com) and
  Tailwind CSS v4, including a complete `<StatusPage>`.

Both read the API of [`createStatusHandler`](../README.md#http-api). The page mirrors the
`services` tree you configured: nothing about your services is repeated on the client.

## A complete page

```bash
npm install sermon-js react react-dom @tanstack/react-query @heroui/react @heroui/styles tailwindcss
```

```css
/* your main stylesheet */
@import "tailwindcss";
@import "@heroui/styles";
@import "sermon-js/react/heroui/styles.css";   /* lets Tailwind find the kit's classes */
```

```tsx
import { applyTheme } from "sermon-js/react";
import { StatusPage } from "sermon-js/react/heroui";

applyTheme();   // the viewer's saved theme, before first paint

export default function App() {
  return <StatusPage baseUrl="/api" brand={<img src="/logo.svg" alt="Acme status" height={28} />} />;
}
```

That gives you the overall score, the history chart, collapsible sections with one status
circle per service, per-service details (response time, percentiles, uptime, sparkline,
per-region rows, usage bars, errors), on-demand checks, a side index on wide screens, deep
links, a stale-data warning and a theme switch. See [`examples/vite`](../examples/vite).

Components are client components (`"use client"`), so they work in the Next.js App Router.

### How the tree becomes a page

| In `services` | On the page |
|---|---|
| A group with services | A collapsible section |
| A group inside it | A sub-heading within that section |
| A group containing only groups | A heading, followed by one section per group |
| Services outside any group | Gathered in a section titled `ungroupedTitle` ("Services") |

Within a section, failing services come first, then critical ones, then by name.

### `<StatusPage>` props

| Prop | Default | |
|---|---|---|
| `baseUrl` | `"/api"` | Where the handler is mounted; may be an absolute URL (enable `cors` on the handler) |
| `client` | | A ready client instead, e.g. with a custom `fetch` |
| `brand` | "Status" | Your logo and title |
| `footer` | interval and retention | Replaces the footer text |
| `ungroupedTitle` | `"Services"` | Title for services declared outside any group |
| `defaultExpanded` | `false` | Start sections open for viewers who haven't chosen |
| `allowRuns` | `true` | Offer "Run all checks" and "Check now" |
| `showNav` | `true` | Side index on wide screens |
| `showThemeSwitcher` | `true` | System / light / dark switch |
| `regionNames` | Fly.io regions | City names for instance regions |
| `refetchInterval` | `30000` | How often the page re-reads the API |
| `queryClient` | built in | Your own React Query client |

Collapsed sections and the theme are remembered per viewer in their browser
(`localStorage`), and everything still works when storage is unavailable.

Colors, corner radius and dark mode follow your HeroUI theme; for example
`:root { --radius: 0.25rem; }` tightens every corner.

## Your own layout

Every piece is exported, to arrange differently or mix with your own:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildLayout, StatusProvider, useStatus } from "sermon-js/react";
import { HistoryBars, RunAllButton, ScoreHeader, ServiceSection, StaleNotice } from "sermon-js/react/heroui";

function Dashboard() {
  const { data } = useStatus();
  if (!data) return null;
  return (
    <>
      <StaleNotice snapshot={data} />
      <ScoreHeader snapshot={data} />
      <HistoryBars />
      {buildLayout(data.tree).map((block) =>
        block.type === "section" ? <ServiceSection key={block.section.key} section={block.section} /> : null
      )}
    </>
  );
}

<QueryClientProvider client={new QueryClient()}>
  <StatusProvider baseUrl="/api">
    <Dashboard />
  </StatusProvider>
</QueryClientProvider>;
```

Components: `StatusPage`, `ScoreHeader`, `ScoreRing`, `HistoryBars`, `ServiceSection`,
`ServiceRow`, `ServiceNav`, `InstanceTable`, `UsageBar`, `Sparkline`, `RunAllButton`,
`ThemeSwitcher`, `StaleNotice`.

## Headless: `sermon-js/react`

Needs only `react` and `@tanstack/react-query`.

| | |
|---|---|
| `createStatusClient({ baseUrl, fetch })` | `status()`, `history(range)`, `serviceHistory(key, range)`, `run(key?)` |
| `StatusProvider` | Gives the hooks a base URL or a client |
| `useStatus()`, `useHistory(range)` | React Query queries, refreshed periodically |
| `useRunChecks()` | Mutation: `mutate()` runs everything, `mutate(key)` one service. A refused run is a `RateLimitError` with `retryAfter` |
| `buildLayout(tree)`, `flattenServices`, `servicesOf`, `sectionsOf` | Turn the snapshot tree into page blocks |
| `statusOf(service)`, `sortServices` | Display status and failing-first order |
| `isStale(snapshot)` | True when the last full run is older than twice the interval |
| `focusAnchor(anchor)`, `serviceAnchor(key)`, `groupAnchor(key)` | Deep links that open collapsed sections first |
| `useThemePreference()`, `applyTheme()` | System / light / dark, remembered per viewer |
| `formatMs`, `formatPct`, `formatDuration`, `timeAgo`, `STATUS_TEXT`, `STATUS_TONE`… | Display helpers |

The snapshot carries `schemaVersion`, so a UI can detect an engine it doesn't understand.
