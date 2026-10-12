import * as THREE from 'three';

/**
 * The scene's colours and the one function that applies them.
 *
 * Shared between the controller, which paints instances, and the legend, which has to
 * describe the same colouring — a key that names one palette while the canvas draws another
 * is worse than no key, because the viewer trusts it.
 */

export type Channel =
  | 'structure' | 'belief' | 'candidates' | 'agent' | 'change' | 'frontier';

export const CHANNEL_HELP: Record<Channel, string> = {
  structure: 'agent-named, path group, or defended',
  belief: 'how much is known, and what is disputed',
  candidates: 'what the static tools flagged, and how densely',
  agent: 'who has worked here',
  change: 'which beliefs their own evidence has moved out from under',
  frontier: 'what nobody has looked at yet, by uncertainty x centrality',
};

export const COLORS = {
  named: new THREE.Color('#7ee0a8'),
  path: new THREE.Color('#5a6675'),
  defended: new THREE.Color('#f0a868'),
  hover: new THREE.Color('#6ea8fe'),
  symbol: new THREE.Color('#8f7fd0'),
};

/**
 * Belief palette. Unknown is deliberately near-invisible: the design's whole point is that
 * absence must look like absence, so an unexamined map should look unexamined.
 */
export const BELIEF: Record<string, THREE.Color> = {
  // Muted, but not invisible: absence should read as absence without erasing the form.
  UNKNOWN: new THREE.Color('#3d4653'),
  INFERRED: new THREE.Color('#8a7bd8'),
  CORROBORATED: new THREE.Color('#7ee0a8'),
  CONFIRMED: new THREE.Color('#6ea8fe'),
  CONTRADICTED: new THREE.Color('#f07a7a'),
  STALE: new THREE.Color('#f0a868'),
};

export const COLD = new THREE.Color('#333b46');
export const HOT = new THREE.Color('#ffd479');
/** A static detector pointed at this. Suspicion, not judgement — so amber, never red. */
export const FLAGGED = new THREE.Color('#d99a4e');
/** Examined and not moved since. Present, but deliberately quiet. */
export const SETTLED = new THREE.Color('#4a5560');

/** Stable per-agent hue, so the same tool keeps its colour across sessions. */
export function agentColor(name: string): THREE.Color {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return new THREE.Color().setHSL(((h >>> 0) % 360) / 360, 0.55, 0.62);
}

const scratch = new THREE.Color();

/** Colour for a node under the active channel. */
export function channelColor(
  node: any, channel: Channel, maxHeat: number, flagged: ReadonlySet<string>,
): THREE.Color {
  // A symbol has no belief, no heat and no agents of its own — every channel would paint it
  // "unknown", which reads as a finding rather than as a level of detail. One colour, so an
  // opened file is legible as structure regardless of what the rest of the map is showing.
  if (node.isSymbol) return COLORS.symbol;
  if (channel === 'belief') {
    const b = node.belief;
    if (!b) return BELIEF.UNKNOWN;
    const base = BELIEF[b.status] ?? BELIEF.UNKNOWN;
    // Coverage drives the gradient: a node where half the members are unexamined should
    // not look as settled as one where all of them are.
    return scratch.copy(BELIEF.UNKNOWN).lerp(base, 0.25 + 0.75 * b.known).clone();
  }
  if (channel === 'candidates') {
    // A detector flagged some of this node's files. Density, not a verdict: one suspicious
    // file in forty is a different thing from forty in forty, and the colour should say so.
    const members: string[] = node.members ?? [];
    if (!members.length || !flagged.size) return BELIEF.UNKNOWN;
    const hit = members.reduce((n, m) => n + (flagged.has(m) ? 1 : 0), 0);
    if (!hit) return BELIEF.UNKNOWN;
    return scratch.copy(BELIEF.UNKNOWN).lerp(FLAGGED, 0.35 + 0.65 * (hit / members.length)).clone();
  }
  if (channel === 'change') {
    // Staleness is the only movement the store actually records: a claim whose file has
    // changed since it was asserted. Everything else here is standing still.
    const b = node.belief;
    if (!b) return BELIEF.UNKNOWN;
    return b.status === 'STALE' ? BELIEF.STALE : scratch.copy(BELIEF.UNKNOWN).lerp(SETTLED, 0.5).clone();
  }
  if (channel === 'frontier') {
    const heat = node.belief?.heat ?? 0;
    return scratch.copy(COLD).lerp(HOT, maxHeat > 0 ? Math.min(1, heat / maxHeat) : 0).clone();
  }
  if (channel === 'agent') {
    const agents: string[] = node.belief?.agents ?? [];
    if (!agents.length) return BELIEF.UNKNOWN;
    return agentColor(agents[0]);
  }
  return node.defended ? COLORS.defended : node.purpose ? COLORS.named : COLORS.path;
}
