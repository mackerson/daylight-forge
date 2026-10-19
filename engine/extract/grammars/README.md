# Vendored tree-sitter WebAssembly

The Rust provider (`../rust-parser.ts`) parses with tree-sitter compiled to WebAssembly, so
mapping a Rust repository needs no native addon and no toolchain. These two files are copied
byte for byte out of the npm registry tarballs below and committed, so a map never depends on
what happens to be in `node_modules`. Only `web-tree-sitter` is a dependency, because the
engine imports its JavaScript; `tree-sitter-rust` is not installed at all — its npm package
carries a native-binding install script and prebuilt `.node` binaries this project never uses.

| File | Package | Version | Registry tarball | Tarball sha256 | File sha256 |
| --- | --- | --- | --- | --- | --- |
| `web-tree-sitter.wasm` | `web-tree-sitter` (runtime) | 0.26.13 | https://registry.npmjs.org/web-tree-sitter/-/web-tree-sitter-0.26.13.tgz | `adf5677e04711c597200058971a299fc9fd4133891ee72ec02acf4932e659fdf` | `99fa2281fc4c6da713ccdadce72e81571b032ab9901b751be2d5aa127c843aaf` |
| `tree-sitter-rust.wasm` | `tree-sitter-rust` (grammar) | 0.24.0 | https://registry.npmjs.org/tree-sitter-rust/-/tree-sitter-rust-0.24.0.tgz | `4248da0b9ea40fec13ef010822e7b92a9d1ebdf74f6f2733539b1dbbb086c5bb` | `f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57` |

Both tarballs match the registry's published integrity (`sha512-5bUZ7vbQ…` and
`sha512-NWemUDf6…`). Both packages are MIT licensed (tree-sitter: Max Brunsfeld;
tree-sitter-rust: Maxim Sokolov).

The file hashes are recorded three times on purpose: here, in `GRAMMAR_FILES` in
`../rust-parser.ts`, which refuses to load a file that does not match, and in
`engine/test/rust-parser.ts`, which fails CI if they disagree.

## What the grammar does not see

Macro arguments are an unparsed token tree, so calls written inside `println!(…)` or
`vec![…]` are not recorded.

## Updating

Nothing here needs either package installed.

1. `npm pack <package>@<version>` in an empty scratch directory (it downloads the tarball
   and runs no scripts), then check `sha256sum` and the registry's `dist.integrity`.
2. `tar -xzf <tarball> package/<file>.wasm` and copy the `.wasm` here.
3. `sha256sum *.wasm`, then update this table and `GRAMMAR_FILES`. For the runtime, also bump
   the exact `web-tree-sitter` version in `package.json`: its JavaScript and wasm must match.
4. `node engine/test/rust-parser.ts`. A grammar built for a newer ABI than the runtime
   supports fails at load, and node type renames show up as missing records.
