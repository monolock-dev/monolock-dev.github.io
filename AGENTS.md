## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Writing style

Docs prose follows ASD-STE100 Simplified Technical English (see the full
language rules in `src/content/docs/comparisons/_template.md`). Abbreviations:
spell out at the first use on each page — "first-in, first-out (FIFO)",
"access-control list (ACL)" — then use the abbreviation alone. Do not spell
out terms the audience knows: TCP, TLS, HTTP(S), API, JSON, DNS, OS, SQL,
URL, URI, SSD, VM, UTF-8, UTC, RFC, EOF. Proper names (SPIFFE, PEM) stay as
they are.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
