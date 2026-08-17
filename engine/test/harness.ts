/**
 * The assertion helper every test file uses.
 *
 * It was copy-pasted into fifteen of them, which D4 reported the moment its token stream was
 * dense enough to see bodies this small — 105 pairs, all the same eight lines. Fixing what
 * the tool finds in our own code is the point of having built it.
 *
 * Kept deliberately small. A test file here is a script that prints what it checked and exits
 * non-zero if anything failed; the value is in the assertion *names* reading as claims about
 * behaviour, and a framework would put ceremony between the reader and those names.
 */

export interface Harness {
  /** Record one assertion. `detail` is printed only on failure, so make it the actual value. */
  check(name: string, cond: boolean, detail?: string): void;
  /** Print the tally and exit non-zero if anything failed. Always the last line of a test. */
  done(): never;
  /** Group heading, so a long run reads as sections rather than a wall. */
  section(title: string): void;
}

export function harness(): Harness {
  let passed = 0;
  let failed = 0;

  return {
    check(name: string, cond: boolean, detail = '') {
      if (cond) {
        passed++;
        console.log(`  ok   ${name}`);
      } else {
        failed++;
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
      }
    },
    section(title: string) {
      console.log(`\n${title}`);
    },
    done(): never {
      console.log(`\n${passed} passed, ${failed} failed`);
      process.exit(failed ? 1 : 0);
    },
  };
}
