# Security: keeping credentials out of pages and logs

A status page is public and its checks hold your API keys, so the library treats every piece
of text that leaves a check as untrusted.

## What is public

Everything returned by `/status`, `/history` and `/services/:key/history`: service names,
descriptions, statuses, latencies, `error`, `metrics`, `usage` and `instances`. Never secrets,
URLs, headers or request bodies of a check.

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
  and unexpected failures of the HTTP handler (`onError`, default `console.error`). The second
  goes through the same redaction, and the raw error object is never printed: database and
  Redis drivers put connection strings in their errors.
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
  the check at a plain health route.
- **In a `custom()` check**, return short, fixed error texts rather than whole response
  bodies, and never put a secret in `metrics`.
- **Protect `/tick` with a header**, not `?key=`: query strings end up in access logs, CDN
  logs and browser history. `?key=` exists for schedulers that can only call a URL; give that
  secret no other use.
- The store holds results that are already redacted, but it also holds your history: keep its
  own credentials out of client code, like any database.
