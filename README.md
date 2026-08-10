# monolock-dev.github.io

Documentation site for [monolock](https://github.com/monolock-dev/monolock),
built with [Astro](https://astro.build) and
[Starlight](https://starlight.astro.build).

## Develop

```sh
npm install
npm run dev
```

Content lives in `src/content/docs/`; the sidebar is configured in
`astro.config.mjs`. Mermaid diagrams in fenced ` ```mermaid ` blocks are
rendered client-side by [astro-mermaid](https://github.com/joesaby/astro-mermaid)
with automatic light/dark theming.

## Deploy

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`.
