# Contributing

Contributions are welcome: bug reports, fixes, improvements to existing mods, and new mods.

## Reporting a bug

[Open an issue](../../issues/new/choose) using the bug report template. Include:

- the mod, your OS and Herdr version, and the output of `rg --version`
- the steps to reproduce it, what you expected and what happened
- any `<name>.error` file in the mod's folder

## Working on a mod

1. Fork and clone the repo.
2. Link the mod into your Herdr config so your edits apply right away:
   ```sh
   ln -s "$PWD/project-search/mods/project-search" ~/.config/herdr-app/mods/project-search
   ```
   Then merge `project-search/keys.json` into `~/.config/herdr-app/keys.json`.
3. Make your change. Herdr reloads mods when they change. If a file is invalid, Herdr
   keeps the last good version and writes the reason to `<name>.error`.
4. Check the mod before you commit:
   ```sh
   herdr-app check ~/.config/herdr-app/mods/project-search
   ```

`~/.config/herdr-app/AGENTS.md` and the `gpui-kit.d.ts` and `herdr.d.ts` type files that
Herdr writes into each mod folder are the reference for the API. Those generated files are
gitignored, so don't commit them.

### Style

Match the surrounding code: plain modern JavaScript, short functions, and comments that
explain *why*. Keep using the theme's colors (`theme()`) and the user's font
(`settings().font_family`) instead of hard-coding them.

### Keep RECIPE.md in sync

Each mod's `RECIPE.md` is the brief another agent rebuilds the mod from, so it's part of
the mod. If your change affects what users see or do, update the recipe in the same pull
request (what you see, behavior, keys, *Watch out*, *Done when*). If the look changes,
update `preview.png` too.

## Adding a new mod

Add a top-level folder in the [herdr.dev/mods](https://herdr.dev/mods/) layout:

```
<mod>/
├── RECIPE.md
├── preview.png
├── keys.json        (only if it binds keys)
└── mods/<mod>/
```

Add a section for it to the README too. Name the mod's folder so it doesn't clash with
Herdr's shipped mods.

## Pull requests

- Keep each PR to one change and describe how you tested it.
- `herdr-app check` passes for every mod you touched.
- If the mod reaches the network, runs new programs, or reads files outside the project or
  its own folder, say so in the PR. People installing the mod are told about these things.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
