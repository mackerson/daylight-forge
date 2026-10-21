/**
 * The CLI's command table and its usage text, apart from cli.ts so that a test can walk the
 * table without running a command.
 *
 * `--help` or `-h` anywhere after a command prints that command's usage and exits 0 before
 * cli.ts parses arguments, resolves `<out>`, opens a store or spawns anything (acceptance F1:
 * `agent --help` spawned the provider roster and `export --help` overwrote tracked files).
 */

/** Every command cli.ts dispatches. engine/test/cli-help.ts checks this against its switch. */
export const COMMANDS = [
  'extract', 'invariants', 'focus', 'map', 'export', 'import', 'adopt', 'check', 'plan', 'derive', 'query',
  'save-invariant', 'try-invariant', 'arbitrate', 'agent', 'run', 'adapters', 'quality',
  'mission', 'experiment', 'artifact', 'events', 'report', 'demo',
  'confirm', 'forge', 'gate', 'work-item', 'spec', 'ingest', 'deps', 'campaign', 'assumption', 'corpus',
] as const;

export const USAGE = `Daylight Software Forge — get all the data, then focus it down.

usage:
  node engine/cli.ts map        <path> [options]   # extract + invariants + focus, one pass
  node engine/cli.ts extract    <path> [options]
  node engine/cli.ts invariants <path> [options]
  node engine/cli.ts focus      <path> [options]
  node engine/cli.ts derive     --out <dir>        # rebuild the stack from cached graph.json
  node engine/cli.ts plan    <path> [options]   # diff the declared target architecture
  node engine/cli.ts check   <path> [--warn-only] [--format json]   # CI gate
  node engine/cli.ts agent      <path> --out <dir> [--tools <roster>] [--batch 5] [--dry-run]
  node engine/cli.ts run        <path> --out <dir> [--rounds 12] [--max-cost <usd>]
                                                   # the whole loop: map, agents until it
                                                   # converges or a ceiling stops it, plan
  node engine/cli.ts adapters   [--probe] [--format json]   # which agent CLIs are installed;
                                                   # --probe runs them to ask what they can do
  node engine/cli.ts quality    --out <dir> [--format json]   # how much of the map can be believed
  node engine/cli.ts export     <path> [--out <dir>] [--confirmed-only]   # writes <path>/.codemap/
  node engine/cli.ts import     <path> [--out <dir>]   # reads <path>/.codemap/knowledge.json
  node engine/cli.ts adopt      <path> [--out <dir>] [--dry-run]   # agent-proposed invariants
  node engine/cli.ts query      [--out <dir>]          # claims and beliefs as JSON, for the GUI
  node engine/cli.ts save-invariant <path> --id <id> --prose '<p>' --predicate <json>
  node engine/cli.ts try-invariant  <path> --predicate <json>   # evaluated, never saved
  node engine/cli.ts arbitrate  [--out <dir>] --subject <s> --predicate <p> --value <v> [--note '<n>']

  node engine/cli.ts mission    create <repo> --objective '<q>' [--kind explore] [--scope a.ts,b.ts]
                                list | inspect <id> | run <id> <repo> --tools <roster> | decide <id> …
                                close <id> --outcome <o> --reason '<r>' | replay <id>
                                export <id> --file <f> | import --file <f>     # all take --out, --format json
  node engine/cli.ts experiment propose <mission-id> --subject <s> --predicate <p> --hypothesis '<h>'
                                        --test <file> --test-path <rel> --expect-exit <n>
                                run <experiment-id> [repo] [--runs 2] [--timeout <s>]
  node engine/cli.ts report     <mission-id> [--file out.md]
                                --project [<id>] [--group runner|actor|model|mission|work-item]
                                          [--origin daylight|ingested] [--since <iso>] [--file f]

  forge (implement missions; every decision takes --confirm <digest8>, the actor is the OS user):
  node engine/cli.ts spec       register <repo> --file <rel> | decompose <spec-mission> <repo> --tools mock:a,mock:b
  node engine/cli.ts work-item  list | show <w> | approve <w> | reject <w> --rationale '<why>' --confirm <c>
  node engine/cli.ts mission    create <repo> --kind implement (--work-item <w> | --no-work-item --objective '<o>' --rationale '<why>')
                                authorize <m> --write [--execute] [--max-usd N] --rationale '<why>' --confirm <c>
  node engine/cli.ts gate       add <m> --role gate|holdout --test <file> --expect-exit 0 --expect-stdout '# fail 0'
                                [--harness node|cargo] [--crate <dir>]   # cargo: --expect-stdout 'test result: ok.'
                                baseline <m> [repo] | lock <m> --rationale '<why>' --confirm <c> | list <m> | evaluate <c>
                                try <repo> --harness node|cargo --test <file> [--crate <dir>] [--expect-exit n --expect-stdout s] [--rev r]
                                    # baseline one test in the sandbox; no store, no mission, no rows; allowed in an agent session
  node engine/cli.ts forge      run <m> <repo> --tools mock[:model] [--max-cost <usd>] [--timeout s] [--keep-workspace]
                                evaluate <c> | candidate <c> [--max-bytes N]
                                approve|reject|override <c> --rationale '<why>' --confirm <c> | apply <c> <repo> --confirm <c>
                                | acknowledge-forgery <c> --rationale '<why>' --confirm <c> [--declined]
  node engine/cli.ts confirm    <operation> <subject> [--write] [--execute] [--max-usd N] [--only x,…]   # what --confirm checks
  node engine/cli.ts ingest     claude-code (--session <uuid> | --all) | list
                                bench --mode mock|live-extract|live-full --fixture <dir> --extractor <script> [--format json]   # live modes refused (P2-R7)
  node engine/cli.ts deps       snapshot <repo> [--out <dir>]   # cargo fetch --locked on the host, with network
                                status <repo> [--out <dir>]     # recorded digest, Cargo.lock match, cache sizes
                                requests [--mission <m>]        # dependencies authors asked for
                                resolve <request-id> [--declined] --rationale '<why>' --confirm <c>
  node engine/cli.ts campaign   validate <plan> <repo> [--rev HEAD] | import <repo> --file <plan> [--rev HEAD] [--campaign <c>] | show <c>
                                approve-plan <c> --rationale '<why>' --confirm <c8> | retry <c> <ticket> --rationale '<why>' --confirm <c8>
                                authorize <c> --expected-gate-set <digest> --roster mock --max-usd-total N --max-usd-per-mission N
                                  --max-turns N --timeout s --max-attempts N --concurrency N --auto-apply integration-ref|none
                                  [--execute] [--wave-size N] [--review-roster a,b] [--fix-lane 5:1.5|off] [--tickets A,B]
                                  [--not-after 72h] [--identity 'Name <email>'] --rationale '<why>' --confirm <c8>
                                gate register <c> --role holdout|gate|regression --file <host path> [--ticket T] --expect-exit n --expect-stdout s | gate list <c>
                                baseline <c> <repo> | lock <c> --ratchet|--no-ratchet --rationale '<why>' [--accept-vacuous x,…]
                                  [--obligations T:ob1,x_…=T:ob2] --confirm <c8>   # binds acceptance obligations to locked gates
                                run <c> <repo> [--concurrency N] [--max-waves K] [--dry-run] | status <c> [<repo>] [--write]
                                halt <c> --rationale '<why>' | resume <c> --halt <d> --rationale '<why>' --confirm <c8>
                                adopt-tip <c> <repo> --halt <d> --rationale '<why>' --confirm <c8>
                                list [<repo>] | report <c> [<repo>] [--wave n | --open | --all] [--format json|md] [--write]
                                refine <c> [<repo>] [--rev <sha>] [--rows-only | --cached]   # maps under <out> only; allowed in an agent session
  node engine/cli.ts assumption list <c> [--status open|pending|confirmed|overturned]
                                record <c> --question '<q>' --default '<d>' [--ticket T] --rationale '<why>' --confirm <c8>
                                confirm <u> | decide <u> --value '<v>' | overturn <u> --value '<v>' --follow-up '<s>' [--lane L] [--scope a,b]
                                  (each --rationale '<why>' --confirm <c8>)
  node engine/cli.ts corpus     register <repo> --manifest <path> [--rev R] [--project alias=<repo>[@rev]]…
                                show|sections <corpus> [--revision cr_…] [--doc K] | ir list <corpus> [--status s] [--kind k] [--stale]
                                extract <corpus> <repo> --tools a,b [--windows w,…] [--force] [--timeout s] | coverage <corpus> [--format json|md] [--write]
  node engine/cli.ts artifact   <digest>
  node engine/cli.ts events     --since <n> [--mission <id>]
  node engine/cli.ts demo       prepare [--dest <dir>] | replay --recording <file>

options:
  --out <dir>            output directory (default:
                         \${XDG_DATA_HOME:-~/.local/share}/daylight/<project>/<checkout>)
  --invariants-file <f>  invariant definitions (default: <repo>/daylight.invariants.json)
  --depth <n>        L1 grouping depth (default: 3)
  --commit <sha>     record the commit this tree came from
  --force            overwrite an out dir that holds a different repo's map
  --include-tests    include test files (excluded from the map, but always read for reachability)
  --predicate <json> try-invariant: the candidate predicate to evaluate
  --top <n>          rows per console table (default: 15)

agent options:
  --tools <roster>   comma-separated 'tool' or 'tool:model' entries. A tool may appear more
                     than once on different models — that is how a run gets two independent
                     sources, which is what corroboration counts.
                       --tools claude:sonnet,claude:opus,codex,grok
  --model <m>        default model for roster entries that do not name one
  --rounds <n>       run: cap on campaign rounds (default: 12)
  --stall <n>        run: consecutive rounds that may change nothing before giving up
                     (default: 2)
  --floor <n>        run: the score the frontier's top item is racing down to (default: 0.05)
  --skip-map         run: work from the map already in the out dir instead of re-reading source
  --batch <n>        frontier items per agent (default: 5)
  --spread           split the frontier across the roster instead of asking every agent the
                     same questions. Covers more ground; corroborates nothing.
  --only <subjects>  comma-separated subjects to restrict the run to. Ranking still applies
                     within them, so this narrows the pool rather than bypassing the queue.
  --concurrency <n>  how many agents run at once (default: 1)
  --max-cost <usd>   hard ceiling on spend for the run
  --mode focus       propose clusters and elisions instead of answering frontier questions
  --dry-run          print the plan and write the prompt(s); spawn nothing
`;

export const ADAPTERS_USAGE = `usage: node engine/cli.ts adapters [--probe] [--format json] [--out <dir>]

  Lists the agent CLIs this tool can drive and whether each is on PATH.
  --probe   also run each installed CLI's own introspection to ask what models it has.
            This executes the provider binaries; without it, none is run.`;

const HELP_FLAGS = new Set(['--help', '-h']);
const PROGRAM = 'node engine/cli.ts';

/** The usage lines that name `command`, each with the indented lines that continue it. */
function linesFor(command: string): string[] {
  const lines = USAGE.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith(`${PROGRAM} ${command} `)) continue;
    out.push(lines[i]);
    while (i + 1 < lines.length && /^ {10,}\S/.test(lines[i + 1]) && !lines[i + 1].includes(PROGRAM)) out.push(lines[++i]);
  }
  return out;
}

/**
 * What to print for `argv` (the arguments after the script) when it asks for help, or null
 * when it does not. A bare or leading `--help`/`-h` is the full usage; an unknown command
 * with one falls through to cli.ts, which prints the full usage and exits 1.
 */
export function helpFor(argv: string[]): string | null {
  const [command, ...rest] = argv;
  if (command !== undefined && HELP_FLAGS.has(command)) return USAGE;
  if (command === undefined || !rest.some((a) => HELP_FLAGS.has(a))) return null;
  if (!(COMMANDS as readonly string[]).includes(command)) return null;
  if (command === 'adapters') return ADAPTERS_USAGE;
  return `usage:\n${linesFor(command).join('\n')}\n\nOptions and the other commands: ${PROGRAM} help`;
}
