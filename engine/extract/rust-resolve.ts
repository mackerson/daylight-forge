import path from 'node:path';

/** One `[package]` from a Cargo.toml, with the file its `crate::` paths start from. */
export interface RustCrate {
  /** Package name as Rust code spells it: hyphens become underscores. */
  name: string;
  /** Repo-relative directory holding the Cargo.toml, `''` at the root. */
  dir: string;
}

/**
 * `[package] name` out of a Cargo.toml, or null when it has none (a virtual workspace root).
 *
 * A line scan, not a TOML parser: the one key needed sits in one well-known table, and taking
 * on a parser dependency to read it would widen the supply chain for no gain in what resolves.
 */
export function packageName(raw: string): string | null {
  let inPackage = false;
  for (const line of raw.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      inPackage = header[1].trim() === 'package';
      continue;
    }
    if (!inPackage) continue;
    const name = /^\s*name\s*=\s*["']([^"']+)["']/.exec(line);
    if (name) return name[1];
  }
  return null;
}

export function crateFromManifest(manifestPath: string, raw: string): RustCrate | null {
  const name = packageName(raw);
  if (!name) return null;
  const dir = path.posix.dirname(manifestPath);
  return { name: name.replace(/-/g, '_'), dir: dir === '.' ? '' : dir };
}

/** `mod foo;`, `crate::`, `self::`, `super::` — paths that can only mean first-party code. */
export function isLocalRustSpec(spec: string): boolean {
  return /^(mod |crate(::|$)|self(::|$)|super(::|$)|\$crate(::|$))/.test(spec);
}

const join = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel);
const dirOf = (file: string): string => {
  const d = path.posix.dirname(file);
  return d === '.' ? '' : d;
};

/**
 * Resolves Rust module paths to repo-relative files, syntactically, without cargo.
 *
 * Follows the 2018-edition file layout: `mod foo;` in `lib.rs`, `main.rs` or `mod.rs` looks
 * beside the declaring file; in any other `bar.rs` it looks in `bar/`. A `use` path walks
 * module files for as long as the next segment names one, and stops at the file holding the
 * item — `crate::units::scale` lands on `units.rs`. `#[path]` attributes, `include!` and
 * build-script output are not seen, and anything not found stays unresolved rather than guessed.
 */
export class RustResolver {
  private readonly known: Set<string>;
  private readonly crates: RustCrate[];

  constructor(known: Set<string>, crates: RustCrate[]) {
    this.known = known;
    // Longest directory first, so a nested crate wins over the workspace that contains it.
    this.crates = [...crates].sort((a, b) => b.dir.length - a.dir.length);
  }

  resolve(spec: string, fromFile: string): string | null {
    if (spec.startsWith('mod ')) {
      // `mod a { mod b; }` is written `mod a::b`: inline levels are directories.
      const segs = spec.slice(4).trim().split('::');
      return this.child(fromFile, segs[segs.length - 1], segs.slice(0, -1));
    }

    // A leading `::` names an extern crate explicitly, which for us means a workspace crate.
    const global = spec.startsWith('::');
    const segs = (global ? spec.slice(2) : spec).split('::').map((s) => s.replace(/^r#/, ''));
    const first = segs[0];
    let cur: string | null;
    let i = 1;

    if (!global && (first === 'crate' || first === '$crate')) {
      cur = this.crateRoot(fromFile);
    } else if (!global && first === 'self') {
      cur = fromFile;
    } else if (!global && first === 'super') {
      cur = fromFile;
      i = 0;
      while (cur && segs[i] === 'super') {
        cur = this.parent(cur);
        i++;
      }
    } else {
      // Uniform paths: a bare first segment is a child module or an extern crate. Rust
      // rejects the ambiguous case, so trying the module first loses nothing.
      cur = (!global && this.child(fromFile, first)) || this.workspaceCrateRoot(first);
    }
    if (!cur) return null;

    for (; i < segs.length; i++) {
      const next = this.child(cur, segs[i]);
      if (!next) break;
      cur = next;
    }
    return cur;
  }

  /** The directory a file's child modules live in. */
  private moduleDir(file: string): string {
    const base = path.posix.basename(file);
    if (base === 'lib.rs' || base === 'main.rs' || base === 'mod.rs' || this.crateRoot(file) === file) {
      return dirOf(file);
    }
    return join(dirOf(file), base.replace(/\.rs$/, ''));
  }

  private child(file: string, name: string, inline: string[] = []): string | null {
    if (![name, ...inline].every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) return null;
    const dir = [this.moduleDir(file), ...inline].filter(Boolean).join('/');
    for (const candidate of [join(dir, `${name}.rs`), join(dir, `${name}/mod.rs`)]) {
      if (this.known.has(candidate)) return candidate;
    }
    return null;
  }

  private parent(file: string): string | null {
    const root = this.crateRoot(file);
    if (root === file) return null;
    const base = path.posix.basename(file);
    if (root === null && (base === 'lib.rs' || base === 'main.rs')) return null;
    const parentDir = base === 'mod.rs' ? dirOf(dirOf(file)) : dirOf(file);
    const candidates = [
      ...(root && dirOf(root) === parentDir ? [root] : []),
      join(parentDir, 'mod.rs'),
      join(parentDir, 'lib.rs'),
      join(parentDir, 'main.rs'),
      ...(parentDir ? [`${parentDir}.rs`] : []),
    ];
    for (const c of candidates) if (c !== file && this.known.has(c)) return c;
    return null;
  }

  private crateOf(file: string): RustCrate | undefined {
    return this.crates.find((c) => c.dir === '' || file.startsWith(`${c.dir}/`));
  }

  /**
   * The root file of the crate `file` belongs to.
   *
   * Each of `src/bin/*.rs`, `tests/*.rs`, `examples/*.rs`, `benches/*.rs` and `build.rs` is a
   * crate of its own. Otherwise `src/main.rs` is its own root and everything else under `src/`
   * hangs off `lib.rs` when there is one — a package with both is a library plus a binary that
   * uses it, and the library is where shared modules are declared.
   */
  crateRoot(file: string): string | null {
    const crate = this.crateOf(file);
    if (!crate) return null;
    const rel = crate.dir ? file.slice(crate.dir.length + 1) : file;
    if (rel === 'build.rs') return file;
    const own = /^(src\/bin|tests|examples|benches)\/([^/]+)(\/.*)?$/.exec(rel);
    if (own) {
      if (!own[3]) return file;
      const main = join(crate.dir, `${own[1]}/${own[2]}/main.rs`);
      return this.known.has(main) ? main : null;
    }
    if (!rel.startsWith('src/')) return null;
    const main = join(crate.dir, 'src/main.rs');
    if (file === main) return main;
    const lib = join(crate.dir, 'src/lib.rs');
    if (this.known.has(lib)) return lib;
    return this.known.has(main) ? main : null;
  }

  private workspaceCrateRoot(name: string): string | null {
    const crate = this.crates.find((c) => c.name === name);
    if (!crate) return null;
    // Another crate is reached through its library; a binary-only package has no public path.
    const lib = join(crate.dir, 'src/lib.rs');
    return this.known.has(lib) ? lib : null;
  }
}
