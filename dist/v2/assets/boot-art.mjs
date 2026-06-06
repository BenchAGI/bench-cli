// boot-art.mjs — committed art data for the BenchAGI boot cinematic.
//
// Two assets, both authored by hand (no PIL, no figlet, no build step):
//   1. WORDMARK — a 5-row block font for the letters B E N C H A G I.
//   2. EAGLE    — a hand-drawn pixel-art raptor mascot rendered with half-blocks,
//      with a few idle frame deltas (blink, breathe) echoing the perched-idle
//      motion in apps/aurelius-presence/ANIMATION-STRATEGY.md.
//
// boot.mjs renders colour/animation from this data at runtime. Keeping the art
// as plain data (not pre-coloured frames) means the Infrared gradient + shimmer
// are computed live and can never go stale against the brand palette.
// Local-only (kestrel-aurelius perimeter).

// --- brand palette (design-kit/colors_and_type.css) -------------------------

export const BRAND = {
  ir50: [255, 107, 138], // #ff6b8a  light infrared
  ir200: [255, 45, 85], //  #ff2d55  canonical brand red
  ir400: [173, 24, 56], //  #ad1838  deep infrared
  chalk: [250, 250, 250], // #fafafa primary text / shimmer crest
  chalkDim: [124, 124, 135], // #7c7c87 eyebrow / tagline
  ink0: [10, 10, 12], //    #0a0a0c  deepest obsidian (page bg)
  ink6: [58, 58, 71], //    #3a3a47  hairline / circuit grid
};

// Infrared gradient stops, left -> right across the wordmark.
export const IR_GRADIENT = [BRAND.ir50, BRAND.ir200, BRAND.ir400];

// --- wordmark block font (5 rows tall) --------------------------------------
// '#' = filled cell, ' ' = empty. Variable width per glyph; boot.mjs kerns
// them with a one-column gap and a wider gap for ' '.

export const GLYPH_ROWS = 5;

export const GLYPHS = {
  B: ["### ", "#  #", "### ", "#  #", "### "],
  E: ["####", "#   ", "### ", "#   ", "####"],
  N: ["#  #", "## #", "# ##", "#  #", "#  #"],
  C: [" ###", "#   ", "#   ", "#   ", " ###"],
  H: ["#  #", "#  #", "####", "#  #", "#  #"],
  A: [" ## ", "#  #", "####", "#  #", "#  #"],
  G: [" ###", "#   ", "# ##", "#  #", " ###"],
  I: ["###", " # ", " # ", " # ", "###"],
  " ": ["  ", "  ", "  ", "  ", "  "],
};

export const WORDMARK = "BENCH AGI";

// --- eagle mascot -----------------------------------------------------------
// A front-facing spread-wing raptor emblem. Authored as a left half (13 cols,
// the last column is the centre spine) and mirrored by boot.mjs, guaranteeing
// symmetry. Each char is a palette index; '.' is transparent.
//
//   1 copper body   2 dark copper   3 light copper
//   4 deep indigo   5 mid indigo (wing edge)
//   6 amber eye     7 gold beak     8 chalk highlight   9 talon/outline

export const EAGLE_PALETTE = {
  "1": [196, 122, 58], //  copper (body)
  "2": [107, 63, 29], //   dark brown (folded wing)
  "3": [227, 164, 99], //  light copper (neck + breast highlight)
  "6": [255, 184, 74], //  amber eye
  "7": [255, 194, 74], //  bright gold (beak + talons)
  "8": [244, 236, 216], // cream / white head
  "9": [42, 26, 15], //    near-black (feather tips, depth)
};

// Left-facing profile raptor — matches the 🦅 orientation (head + hooked beak to
// the left, folded wing sweeping back to a tail on the right, talons below).
// Authored as a full 22-col sprite; a profile is asymmetric, so no mirroring.
export const EAGLE_PROFILE = [
  ".........8888.........", // 0  white head crown
  ".......88888888.......", // 1  head
  "......888888888.......", // 2  head
  "......8888888831......", // 3  head, neck (light copper) meets body
  "....77868888883111....", // 4  hooked gold beak + amber eye on the white head
  "...7786888888831111...", // 5  beak tip + eye, head into body
  "....7788888311111.....", // 6  beak underside, neck
  ".....88831111111......", // 7  neck into copper body
  ".....3311111111222....", // 8  body, folded wing edge (dark brown)
  ".....331111112222229..", // 9  breast highlight + folded wing + dark tip
  "......33111122222229..", // 10 breast highlight + wing
  "......1111112222222299", // 11 body + wing + tail (dark tips)
  ".......11112222222229.", // 12 tail sweeping back/right
  ".......11112222222299.", // 13
  "........111222222229..", // 14
  "........11222222299...", // 15
  ".........1112222299...", // 16 lower body + tail tip
  ".........1111122999...", // 17 belly + dark tail tips
  "..........7..7........", // 18 legs (gold)
  "..........7..7........", // 19
  ".........7777777......", // 20 talons / perch grip
];

export function eagleSprite() {
  return EAGLE_PROFILE.slice();
}

// --- idle frame deltas (cheap, echo ANIMATION-STRATEGY.md) -------------------
// Each returns a full sprite. Decorrelated timers in boot.mjs schedule these so
// the idle never looks periodic.

// Helper: replace the character at a column index (rows are immutable strings).
function setCell(row, col, ch) {
  if (col < 0 || col >= row.length) return row;
  return row.slice(0, col) + ch + row.slice(col + 1);
}

// Blink: the amber eye (6) briefly closes to the head colour (3).
export function eagleBlink() {
  return eagleSprite().map((row) => row.replace(/6/g, "3"));
}

// Breathe-in: a subtle light-copper sheen on the breast (rows 9-10) — reads as a
// small chest swell without altering the silhouette. Echoes the ~4s breathe loop.
export function eagleBreathe() {
  const rows = eagleSprite();
  for (const i of [9, 10]) {
    for (const c of [6, 7, 8]) {
      if (rows[i][c] === "1") rows[i] = setCell(rows[i], c, "3");
    }
  }
  return rows;
}

export const TAGLINE = "LOCAL-ONLY · OPERATOR SEAT";
