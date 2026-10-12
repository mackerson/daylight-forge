import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDaylight } from '../mission/context.ts';
import { importMission, readExport } from '../mission/export.ts';
import { createMission, proposeExperiment } from '../mission/orchestrate.ts';
import { currentRevision } from '../mission/project.ts';
import type { Experiment, Mission } from '../mission/types.ts';
import { EXPECTED_FIXTURE_COMMIT, FIXTURE_DIR, materialiseFixture } from './fixture.ts';

/**
 * The guided demo, set up without a model in the loop.
 *
 * `prepare` makes the fixture into a repository, maps it, opens an explore mission on the
 * one module with the planted defect, and registers the fixture's own red test as the
 * experiment — prediction: exit 1, because the test fails at this revision. What it does
 * *not* do is run any reviewer or invent what one would have said: the reviews come from
 * `mission run` with a real roster, or from `replay` with a recording of one.
 *
 * Everything the fixture says about itself — PLANTED, deliberately — travels into the
 * mission objective verbatim, so no report or screen can present the defect as found.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'cli.ts');

export const DEMO_SUBJECT = 'src/session-cache.ts';
export const DEMO_TEST_PATH = 'test/session-cache.test.js';
export const DEMO_COMMAND = ['node', '--test', DEMO_TEST_PATH];

const PLANTED =
  'PLANTED fixture: this repository is the Daylight demo fixture and its defect was placed ' +
  'deliberately (see DEFECT.md). It is not an independently discovered production defect.';

/**
 * The question the fixture's reviewer prompt asks, lifted from the prompt file so the two
 * cannot drift. The rules above it are re-added by `buildReviewPrompt`; the closing
 * instruction is too, so both are cut here.
 */
export function demoObjective(): string {
  const text = fs.readFileSync(path.join(FIXTURE_DIR, 'review-prompts', 'reviewer.md'), 'utf8');
  const start = text.indexOf('Your assigned question:');
  const body = start >= 0 ? text.slice(start + 'Your assigned question:'.length) : text;
  const stop = body.indexOf('\nStart with ');
  const question = (stop >= 0 ? body.slice(0, stop) : body)
    .split('\n')
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n')
    .trim();
  return `${question}\n\n${PLANTED}`;
}

/** A directory that already holds the fixture at the pinned commit is reused, not refused. */
function fixtureRepo(dest: string): ReturnType<typeof materialiseFixture> {
  const root = path.resolve(dest);
  if (fs.existsSync(root) && fs.readdirSync(root).length) {
    const rev = currentRevision(root);
    if (rev.commit === EXPECTED_FIXTURE_COMMIT && !rev.dirty) {
      return materialisedView(root);
    }
    throw new Error(
      `${root} is not empty and is not the fixture at ${EXPECTED_FIXTURE_COMMIT.slice(0, 12)}` +
        `${rev.commit ? ` (it is at ${rev.commit.slice(0, 12)}${rev.dirty ? '+dirty' : ''})` : ''}; ` +
        'choose another --dest',
    );
  }
  const made = materialiseFixture(root);
  if (made.commit !== EXPECTED_FIXTURE_COMMIT) {
    throw new Error(
      `the fixture materialised at ${made.commit}, not the pinned ${EXPECTED_FIXTURE_COMMIT}; ` +
        'the fixture tree has changed and EXPECTED_FIXTURE_COMMIT needs updating with it',
    );
  }
  return made;
}

function materialisedView(root: string): ReturnType<typeof materialiseFixture> {
  // Re-derive what `materialiseFixture` would have returned for a repo that already exists.
  const revision = currentRevision(root);
  const identity = { id: `git:${EXPECTED_FIXTURE_COMMIT.slice(0, 12)}`, root, name: path.basename(root) };
  return { root, commit: revision.commit ?? '', projectId: identity.id, revision, identity };
}

function mapInto(root: string, out: string): void {
  execFileSync(process.execPath, [CLI, 'map', root, '--out', out, '--top', '0'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

export interface Prepared {
  root: string;
  commit: string;
  projectId: string;
  out: string;
  missionId: string;
  experimentId: string;
  mission: Mission;
  experiment: Experiment;
}

export function prepareDemo(out: string, dest: string): Prepared {
  const fixture = fixtureRepo(dest);
  mapInto(fixture.root, out);
  const ctx = openDaylight(out);
  try {
    const mission = createMission(ctx, {
      repo: fixture.root,
      kind: 'explore',
      objective: demoObjective(),
      scope: { paths: [DEMO_SUBJECT] },
    });
    const testFile = path.join(fixture.root, DEMO_TEST_PATH);
    const experiment = proposeExperiment(ctx, {
      missionId: mission.id,
      subject: DEMO_SUBJECT,
      predicate: 'bug_verdict',
      hypothesis:
        `${DEMO_SUBJECT} serves an expired session: SessionCache.get refreshes expiresAt before ` +
        `checking it, so the registered test "an expired session is not served" fails at ` +
        `${fixture.commit.slice(0, 12)}. ${PLANTED}`,
      prediction: { exitCode: 1 },
      testSource: fs.readFileSync(testFile, 'utf8'),
      testPath: DEMO_TEST_PATH,
      command: DEMO_COMMAND,
    });
    return {
      root: fixture.root, commit: fixture.commit, projectId: fixture.projectId, out,
      missionId: mission.id, experimentId: experiment.id, mission, experiment,
    };
  } finally {
    ctx.close();
  }
}

export interface Replayed {
  root: string;
  commit: string;
  projectId: string;
  out: string;
  mission: Mission;
  added: Record<string, number>;
  skipped: Record<string, number>;
}

/**
 * A recorded mission, on a machine that never ran it: the fixture is made, mapped, and the
 * recording imported against it. The import's own project check holds — a recording of some
 * other repository is refused here the same as anywhere.
 */
export function replayDemo(out: string, dest: string, recording: string, force = false): Replayed {
  const file = readExport(recording);
  const fixture = fixtureRepo(dest);
  mapInto(fixture.root, out);
  const ctx = openDaylight(out);
  try {
    const result = importMission(ctx, file, { force });
    return {
      root: fixture.root, commit: fixture.commit, projectId: fixture.projectId, out,
      mission: result.mission, added: result.added, skipped: result.skipped,
    };
  } finally {
    ctx.close();
  }
}
