# Security: keeping credentials out of pages and logs

A status page is public and its checks hold your API keys, so the library treats every piece
of text that leaves a check as untrusted.

## What is public

Without an `access` function on the handler: everything returned by `/status`, `/status/at`,
`/history` and `/services/:key/history`, that is service names, descriptions, statuses,
latencies, `error`, `metrics`, `usage` and `instances`. Never secrets, URLs, headers or
request bodies of a check.

With [`access`](../README.md#public-and-full-views), anonymous viewers only get the overall
score, the history chart and one status per top-level group; history bars name groups, not
services. Service details, on-demand runs and per-service history are for viewers your
function allows. Public responses never depend on cookies (so a CDN can't serve a signed-in
viewer's page to someone else), full responses are `private, no-store`, and an `access`
function that throws means the public view.

## What is redacted, and where

Redaction happens in one place, before a result is stored or returned, on **all** of its text
(`error`, metric names and values, usage labels, instance fields):

- every value given in `secrets`, plus its URL-encoded, JSON-escaped and base64 forms
- the string fields of JSON secrets (e.g. the private key in a service-account file)
- the user and the password of connection strings given as secrets
- credentials written in `generic.http` headers (`Authorization`, `x-api-key`, cookies…)
- `user:pass@` in any URL, and every query string
- `Bearer …`, `Basic …`, `Token …` values
- anything shaped like a well-known credential, even if it was never declared: PEM blocks,
  JWTs, `sk-…`, GitHub, Slack, Fly, AWS and Google keys, including the partly masked form
  providers echo back (`sk-proj-****abcd`)

Text is redacted first and truncated after, so a secret is never cut in half and left behind.

When a provider answers **401, 403 or 407**, its response body is not shown at all: the error
is just `HTTP 401: credentials rejected`. That is where providers quote the key you sent.

## Logs

- The library logs two things: configuration warnings (`onWarning`, default `console.warn`)
  and unexpected failures of the HTTP handler, including a failing `access` function
  (`onError`, default `console.error`). The second goes through the same redaction, and the
  raw error object is never printed: database and Redis drivers put connection strings in
  their errors.
- `status.redact(text)` applies the same redaction to anything you log yourself.
- `secrets` is a hidden (non-enumerable) property of a service, so `console.log(status)`,
  `JSON.stringify`, object spreads and error reporters that capture context don't print it.
- Google access tokens are kept in memory only, never in the store.

## What you need to do

- **Put every credential in `secrets`.** A key placed in a URL path (webhook URLs, bot tokens)
  or built into a string by hand is only caught if it matches a known shape.
- **Secrets shorter than 6 characters are not redacted** (they would blank out ordinary words).
  Don't use them.
- **Responses of your own services are quoted in errors** (the first 200 characters of a
  non-2xx body, except 401/403). If an internal service can answer with a debug page, point
  the check at a plain health route, or set `hideResponseBodies: true` in `defineStatus`:
  failed answers are then reported by status code only (`HTTP 500`). It is off by default.
- **If the page shouldn't tell the world which providers you use**, set `access` on the
  handler: anonymous viewers then only see one status per top-level group.
- **In a `custom()` check**, return short, fixed error texts rather than whole response
  bodies, and never put a secret in `metrics`.
- **Protect `/tick` with a header**, not `?key=`: query strings end up in access logs, CDN
  logs and browser history. `?key=` exists for schedulers that can only call a URL; give that
  secret no other use.
- The store holds results that are already redacted, but it also holds your history: keep its
  own credentials out of client code, like any database.
