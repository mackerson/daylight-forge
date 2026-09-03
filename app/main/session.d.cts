/** Types for session.cjs, which the Electron main process requires and the suite tests. */
export declare function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean;
export declare function repoOfDir(dir: string): string | null;
export declare function derivedDirFor(repo: string, base: string): string;
export declare function dirForRepo(repo: string, opts: { chosen: Map<string, string>; base: string }): string;
export declare function ownershipConflict(
  repo: string | null,
  dir: string,
): { dir: string; holds: string; repo: string } | null;
