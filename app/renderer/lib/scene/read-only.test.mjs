/**
 * The read-only Scene (P2-R45 D3). Run: node app/renderer/lib/scene/read-only.test.mjs
 *
 * The Refine view draws the integration tip's map, which is not the checkout's: a layout read
 * or write, a symbols call, a node drag or an alt-click expand would each reach the checkout's
 * map directory. The rules are pure functions the Scene and its controller call; this pins them
 * and pins that the two files route every such call through them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dragAllowed, expandAllowed, layoutReadable, sceneIo } from './read-only.ts';
import { harness } from '../../../../engine/test/harness.ts';

const { check, section, done } = harness();
const here = path.dirname(fileURLToPath(import.meta.url));
const REASON = 'read-only: the integration tip';

section('no drag and no alt-click expand on a read-only scene');
{
  const node = { isRoot: false, isFile: true };
  check('a drag on a node moves it on the checkout\'s map', dragAllowed(false, false, false, node));
  check('never on a read-only scene', !dragAllowed(true, false, false, node));
  check('a pan, a ctrl-orbit, empty space and the root never move a node either',
    !dragAllowed(false, true, false, node) && !dragAllowed(false, false, true, node) && !dragAllowed(false, false, false, null) && !dragAllowed(false, false, false, { isRoot: true }));
  check('alt-click opens a file on the checkout\'s map', expandAllowed(false, true, node));
  check('never on a read-only scene', !expandAllowed(true, true, node));
  check('a plain click or a non-file expands nothing', !expandAllowed(false, false, node) && !expandAllowed(false, true, { isFile: false }) && !expandAllowed(false, true, null));
}

section('no layout read or write and no symbols call');
{
  const calls = [];
  const d = {
    layout: async (p) => { calls.push(['layout', p]); return { moved: { a: [1, 2, 3] } }; },
    symbols: async (p) => { calls.push(['symbols', p]); return { symbols: [{ id: 'a#f', name: 'f', kind: 'function' }] }; },
  };
  check('a map with a dir reads its layout', layoutReadable('/out', undefined));
  check('a read-only map never does, dir or not', !layoutReadable('/out', REASON) && !layoutReadable(undefined, REASON));
  check('a map with no dir never does', !layoutReadable(undefined, undefined));
  const ro = sceneIo(REASON, d);
  const read = await ro.layout();
  const write = await ro.layout({ repo: '/r', moved: { a: [0, 0, 0] } });
  const syms = await ro.symbols({ file: 'src/a.ts' });
  check('read-only: a layout read answers nothing moved', Object.keys(read.moved).length === 0);
  check('read-only: a layout write is dropped', Object.keys(write.moved).length === 0);
  check('read-only: symbols answer none', syms.symbols.length === 0);
  check('and none of the three reached main', calls.length === 0, JSON.stringify(calls));
  const rw = sceneIo(undefined, d);
  await rw.layout();
  await rw.symbols({ file: 'src/a.ts' });
  check('without readOnly both calls go through, unchanged', calls.length === 2 && calls[1][1].file === 'src/a.ts');
}

section('the Scene and its controller go through these rules');
{
  const scene = fs.readFileSync(path.join(here, '..', 'panels', 'Scene.tsx'), 'utf8');
  const ctrl = fs.readFileSync(path.join(here, 'controller.ts'), 'utf8');
  check('Scene never calls layout or symbols on window.daylight directly', !/window\.daylight\.(layout|symbols)\(/.test(scene));
  check('Scene builds its calls with sceneIo(readOnly, …) and gates the layout read with layoutReadable', /sceneIo\(readOnly,/.test(scene) && /layoutReadable\(data\?\.dir, readOnly\)/.test(scene));
  check('Scene passes readOnly to the controller', /readOnly: !!readOnly/.test(scene));
  check('the controller guards the drag start and the alt-click with the rules',
    /dragAllowed\(!!this\.opts\.readOnly/.test(ctrl) && /expandAllowed\(!!this\.opts\.readOnly/.test(ctrl) && !/!this\.panning && !e\.ctrlKey && hovered/.test(ctrl));
  check('the keys line shows the reason instead of the drag and alt-click hints', /data-forge="read-only-reason"/.test(scene));
}

done();
