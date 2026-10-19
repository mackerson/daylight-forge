# Vendored tree-sitter WebAssembly

The Rust provider (`../rust-parser.ts`) parses with tree-sitter compiled to WebAssembly, so
mapping a Rust repository needs no native addon and no toolchain. These two files are copied
byte for byte out of the npm packages pinned in `package.json`, and committed so a map never
depends on what happens to be in `node_modules`.

| File | Source package | Version | sha256 |
| --- | --- | --- | --- |
| `web-tree-sitter.wasm` | [`web-tree-sitter`](https://www.npmjs.com/package/web-tree-sitter) (`web-tree-sitter.wasm`, the runtime) | 0.26.13 | `99fa2281fc4c6da713ccdadce72e81571b032ab9901b751be2d5aa127c843aaf` |
| `tree-sitter-rust.wasm` | [`tree-sitter-rust`](https://www.npmjs.com/package/tree-sitter-rust) (`tree-sitter-rust.wasm`, the grammar) | 0.24.0 | `f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57` |

Both are MIT licensed (tree-sitter: Max Brunsfeld; tree-sitter-rust: Maxim Sokolov).

The hashes are recorded three times on purpose: here, in `GRAMMAR_FILES` in
`../rust-parser.ts`, which refuses to load a file that does not match, and in
`engine/test/rust-parser.ts`, which fails CI if the three disagree.

## Updating

1. `pnpm add --save-exact web-tree-sitter@<version> tree-sitter-rust@<version>`.
2. Copy `node_modules/web-tree-sitter/web-tree-sitter.wasm` and
   `node_modules/tree-sitter-rust/tree-sitter-rust.wasm` here.
3. `sha256sum *.wasm`, then update this table and `GRAMMAR_FILES`.
4. `node engine/test/rust-parser.ts`. A grammar built for a newer ABI than the runtime
   supports fails at load, and node type renames show up as missing records.

`tree-sitter-rust` declares an install script that builds a native Node binding.
`pnpm-workspace.yaml` sets `allowBuilds: tree-sitter-rust: false`, so it never runs: the
package is a source for the `.wasm` file, nothing more.
