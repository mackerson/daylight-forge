//! A regression gate that runs `cargo test --workspace` itself (docs/daylight/CARGO.md, "Gates
//! that run cargo"). It captures the nested run and asserts on its exit status; on failure it
//! prints a summary, never the nested output. Daylight reads a cargo gate from exactly one
//! `Running tests/daylight_<x_id>.rs (` line and one `test result:` line, so a gate that echoes
//! a nested run's lines reads as `invalid` (P2-R30).

use std::path::{Path, PathBuf};
use std::process::Command;

/// Set on the nested run, where this same target is built and run again: there it returns.
const NESTED: &str = "DAYLIGHT_NESTED_CARGO";

#[test]
fn workspace_tests_pass() {
    if std::env::var_os(NESTED).is_some() {
        return;
    }
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = crate_dir
        .ancestors()
        .find(|d| d.join("Cargo.lock").is_file())
        .unwrap_or(crate_dir);
    // The outer `cargo test` holds the lock on its own target directory.
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target"))
        .join("daylight-nested");
    let out = Command::new(env!("CARGO"))
        .args(["test", "--offline", "--workspace"])
        .current_dir(root)
        .env(NESTED, "1")
        .env("CARGO_TARGET_DIR", &target)
        .output();
    match out {
        Ok(o) if o.status.success() => {}
        Ok(o) => panic!("nested cargo test failed ({}):\n{}", o.status, summary(&o.stdout, &o.stderr)),
        Err(e) => panic!("could not start cargo: {e}"),
    }
}

/// The failing tests and cargo's error lines, at most 20, without cargo's `Running` or
/// `test result:` lines.
fn summary(stdout: &[u8], stderr: &[u8]) -> String {
    let text = format!("{}\n{}", String::from_utf8_lossy(stdout), String::from_utf8_lossy(stderr));
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| (l.starts_with("test ") && l.ends_with("FAILED")) || l.starts_with("error"))
        .filter(|l| !l.contains("test result:") && !l.contains("Running "))
        .take(20)
        .collect();
    lines.join("\n")
}
