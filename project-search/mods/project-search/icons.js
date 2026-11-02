// File icons: Herdr's program glyphs (icons/*.svg, one color) in each language's color,
// else a small lettered badge; a plain page for anything unknown.

import { div, svg } from "gpui-kit";

// By exact file name first, then by extension.
const NAMES = {
  "dockerfile": ["docker", "#2496ed"], "containerfile": ["podman", "#892ca0"],
  "makefile": ["make", "#6d8086"], "gnumakefile": ["make", "#6d8086"],
  "cmakelists.txt": ["cmake", "#064f8c"], "package.json": ["npm", "#cb3837"],
  "package-lock.json": ["npm", "#cb3837"], "pnpm-lock.yaml": ["pnpm", "#f69220"],
  "yarn.lock": ["yarn", "#2c8ebb"], "bun.lockb": ["bun", "#c9a26d"], "bun.lock": ["bun", "#c9a26d"],
  "cargo.toml": ["cargo", "#dea584"], "cargo.lock": ["cargo", "#dea584"],
  "go.mod": ["go", "#00add8"], "go.sum": ["go", "#00add8"],
  "pyproject.toml": ["python", "#3776ab"], "requirements.txt": ["python", "#3776ab"],
  "uv.lock": ["uv", "#de5fe9"], "poetry.lock": ["poetry", "#60a5fa"],
  "gemfile": ["ruby", "#cc342d"], "gemfile.lock": ["ruby", "#cc342d"],
  "composer.json": ["composer", "#885630"], "flake.nix": ["nix", "#7e7eff"],
  "tsconfig.json": ["tsc", "#3178c6"], "deno.json": ["deno", "#70ffaf"],
  "build.gradle": ["gradle", "#02303a"], "build.gradle.kts": ["gradle", "#02303a"], "pom.xml": ["mvn", "#c71a36"],
  ".gitignore": ["git", "#f05032"], ".gitattributes": ["git", "#f05032"], ".gitmodules": ["git", "#f05032"],
  ".eslintrc": ["eslint", "#4b32c3"], ".prettierrc": ["prettier", "#f7b93e"],
  "claude.md": ["claude", "#d97757"], "agents.md": ["agent", "#8b7cf6"],
};
const PREFIXES = [
  ["vite.config.", ["vite", "#a855f7"]], ["vitest.config.", ["vitest", "#729b1b"]], ["jest.config.", ["jest", "#c21325"]],
  ["next.config.", ["next", "#888888"]], ["nuxt.config.", ["nuxt", "#00dc82"]], ["astro.config.", ["astro", "#ff5d01"]],
  ["webpack.config.", ["webpack", "#8dd6f9"]], ["eslint.config.", ["eslint", "#4b32c3"]], ["tailwind.config.", null],
  ["docker-compose", ["docker", "#2496ed"]], ["compose.y", ["docker", "#2496ed"]], ["wrangler.", ["wrangler", "#f38020"]],
];
const EXT = {
  py: ["python", "#3776ab"], pyi: ["python", "#3776ab"], pyw: ["python", "#3776ab"], ipynb: ["jupyter", "#f37626"],
  go: ["go", "#00add8"], rs: ["cargo", "#dea584"], zig: ["zig", "#f7a41d"],
  ts: ["tsc", "#3178c6"], mts: ["tsc", "#3178c6"], cts: ["tsc", "#3178c6"], tsx: ["tsc", "#3178c6"],
  js: ["node", "#5fa04e"], mjs: ["node", "#5fa04e"], cjs: ["node", "#5fa04e"], jsx: ["node", "#5fa04e"],
  rb: ["ruby", "#cc342d"], php: ["php", "#777bb4"], java: ["java", "#e76f00"],
  kt: ["kotlin", "#a97bff"], kts: ["kotlin", "#a97bff"], scala: ["scala", "#dc322f"], sc: ["scala", "#dc322f"],
  swift: ["swift", "#f05138"], dart: ["dart", "#00b4ab"], lua: ["lua", "#6c78d4"],
  ex: ["iex", "#6e4a7e"], exs: ["iex", "#6e4a7e"], heex: ["iex", "#6e4a7e"], erl: ["erl", "#a90533"], hrl: ["erl", "#a90533"],
  hs: ["ghci", "#5e5086"], ml: ["ocaml", "#ef7a08"], mli: ["ocaml", "#ef7a08"], jl: ["julia", "#9558b2"],
  r: ["r", "#276dc3"], pl: ["perl", "#39457e"], pm: ["perl", "#39457e"], nix: ["nix", "#7e7eff"],
  tf: ["terraform", "#7b42bc"], tfvars: ["terraform", "#7b42bc"], hcl: ["terraform", "#7b42bc"],
  sh: ["shell", "#4eaa25"], bash: ["shell", "#4eaa25"], zsh: ["shell", "#4eaa25"], fish: ["shell", "#4eaa25"],
  sql: ["psql", "#336791"], prisma: ["prisma", "#5a67d8"], astro: ["astro", "#ff5d01"],
  cs: ["dotnet", "#512bd4"], fs: ["dotnet", "#512bd4"], csproj: ["dotnet", "#512bd4"], sln: ["dotnet", "#512bd4"],
  vim: ["vim", "#019733"], el: ["emacs", "#7f5ab6"], gradle: ["gradle", "#02303a"], cmake: ["cmake", "#064f8c"],
  dockerfile: ["docker", "#2496ed"], mk: ["make", "#6d8086"],
};
// Lettered badges where no glyph fits: [text, color].
const BADGES = {
  json: ["{}", "#cbcb41"], jsonc: ["{}", "#cbcb41"], json5: ["{}", "#cbcb41"],
  md: ["M↓", "#519aba"], mdx: ["M↓", "#519aba"], markdown: ["M↓", "#519aba"], rst: ["R", "#519aba"], txt: ["≡", "#8a8a8a"],
  yml: ["Y", "#cb171e"], yaml: ["Y", "#cb171e"], toml: ["T", "#9c4221"], ini: ["⚙", "#6d8086"], cfg: ["⚙", "#6d8086"], conf: ["⚙", "#6d8086"], env: ["⚙", "#ecd53f"],
  html: ["<>", "#e34c26"], htm: ["<>", "#e34c26"], xml: ["<>", "#e37933"], svg: ["◇", "#ffb13b"], vue: ["V", "#41b883"], svelte: ["S", "#ff3e00"],
  css: ["#", "#663399"], scss: ["#", "#c6538c"], sass: ["#", "#c6538c"], less: ["#", "#1d365d"],
  c: ["C", "#555599"], h: ["h", "#a074c4"], cpp: ["C+", "#f34b7d"], cc: ["C+", "#f34b7d"], hpp: ["h+", "#a074c4"], m: ["m", "#438eff"],
  lock: ["🔒", "#8a8a8a"], csv: ["▦", "#89e051"], tsv: ["▦", "#89e051"], log: ["≡", "#8a8a8a"],
  graphql: ["◈", "#e10098"], gql: ["◈", "#e10098"], proto: ["P", "#4a90e2"],
  png: ["▣", "#a074c4"], jpg: ["▣", "#a074c4"], jpeg: ["▣", "#a074c4"], gif: ["▣", "#a074c4"], webp: ["▣", "#a074c4"],
};

function lookup(path) {
  const name = path.split("/").pop().toLowerCase();
  if (NAMES[name]) return { icon: NAMES[name] };
  for (const [p, v] of PREFIXES) if (name.startsWith(p) && v) return { icon: v };
  const ext = name.includes(".") ? name.split(".").pop() : "";
  if (EXT[ext]) return { icon: EXT[ext] };
  if (name.startsWith(".env")) return { badge: BADGES.env };
  if (BADGES[ext]) return { badge: BADGES[ext] };
  return {};
}

// A 14px icon for a file path.
export function fileIcon(t, path, size = 14) {
  const { icon, badge } = lookup(path);
  if (icon) return svg(`icons/${icon[0]}.svg`).size(size).flex_none().text_color(icon[1]);
  if (badge) {
    return div().w(size + 2).h(size).flex_none().flex().items_center().justify_center().rounded(3)
      .text_size(badge[0].length > 1 ? size * 0.58 : size * 0.72).font_bold().text_color(badge[1]).child(badge[0]);
  }
  return svg("mods/files/file.svg").size(size).flex_none().text_color(t.dim);
}
