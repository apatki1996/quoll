//@values comments
// Phase 8 quiet mode: only //?-annotated lines render their value inline.
// Auto-captured expressions are suppressed; coverage is unaffected.
const shown = 6 * 7; //? //== 42
const hidden = 1 + 2; //==
const counted = 10 - 4; //~ covered //==
