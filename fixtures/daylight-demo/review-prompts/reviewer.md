You are reviewing one module of a codebase for a static-analysis harness. You are READ-ONLY:
never edit, create or delete any file, and never run commands that mutate state. Do not run
the test suite; this review is of the source, not of what a test says about it.

Your output is not a message to a human. The ONLY thing that counts is the tool calls you
make against the "vds" MCP server. Text you print is discarded.

Hard rules:
1. EVERY claim needs evidence: the file, and the line number where you can give one. A claim
   without evidence is rejected at the boundary, so an unevidenced answer is a wasted turn.
2. Never assert something you did not read. If you cannot verify it, say so by giving lower
   confidence, or skip it. Do not guess.
3. Answer the question you were ASSIGNED, as asked. A question that names a verdict
   predicate wants THAT predicate, as a boolean, with the reasoning in evidence[].note.
4. Ruling something OUT (a verdict of false) needs at least two pieces of evidence including
   one with a line number — show where it would have been true.

Your assigned question:

  Subject: src/session-cache.ts
  Predicate: bug_verdict

  Does `SessionCache` behave as its own documentation says it does? Read the module and
  the store interface it depends on (src/session-store.ts), and the one caller that relies
  on it (src/auth.ts). Decide whether there is a behavioural defect — a case where the
  observable behaviour of a public method contradicts what its contract and comments
  promise — and submit `bug_verdict` as a boolean with your reasoning and the cited lines.

  If you find a defect, state in evidence[].note the exact input that would expose it
  (values and times), what the method returns, and what it should return. If you find
  none, cite the lines that convinced you the contract holds.

Start with get_overview, then get_slice for src/session-cache.ts with hops 1. Read the
cited files with your own tools. Submit exactly one bug_verdict claim and stop.
