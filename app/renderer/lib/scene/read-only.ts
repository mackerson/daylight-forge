/**
 * The read-only Scene's rules (P2-R45 D3), pure so they are tested without a window
 * (read-only.test.mjs). A Scene embedded on a map that is not the checkout's — the Refine view
 * draws the integration tip's — must not read or write a layout, fetch symbols, move a node or
 * expand a file: each of those reads or writes the checkout's map directory, which is not the
 * map on screen.
 */

/** A drag on a node moves it; never on a read-only scene, a pan, a ctrl-orbit or the root. */
export const dragAllowed = (readOnly: boolean, panning: boolean, ctrlKey: boolean, hovered: { isRoot?: boolean } | null): boolean =>
  !readOnly && !panning && !ctrlKey && !!hovered && !hovered.isRoot;

/** Alt-click opens a file to its symbols; never on a read-only scene. */
export const expandAllowed = (readOnly: boolean, altKey: boolean, hovered: { isFile?: boolean } | null): boolean =>
  !readOnly && altKey && !!hovered?.isFile;

/** The layout file is read only for a map that has a directory and is not read-only. */
export const layoutReadable = (dir: string | null | undefined, readOnly: string | undefined): boolean => !!dir && !readOnly;

type LayoutCall = (payload?: { repo: string; moved: Record<string, [number, number, number]> }) => Promise<{ moved?: Record<string, [number, number, number]>; ok?: boolean; error?: string }>;
type SymbolsCall = (p: { file: string }) => Promise<{ symbols: Array<{ id: string; name: string; kind: string }>; error?: string }>;

/**
 * The two map-directory calls the Scene makes, or, read-only, stand-ins that never reach main:
 * a layout read answers nothing moved, a layout write is dropped, and symbols answer none.
 */
export function sceneIo(readOnly: string | undefined, d: { layout: LayoutCall; symbols: SymbolsCall }): { layout: LayoutCall; symbols: SymbolsCall } {
  if (!readOnly) return { layout: (p) => d.layout(p), symbols: (p) => d.symbols(p) };
  return {
    layout: async () => ({ moved: {}, error: readOnly }),
    symbols: async () => ({ symbols: [], error: readOnly }),
  };
}
