export { openStore, Store, type StoreOptions } from "./store.ts";
export { systemClock, type Clock } from "./db.ts";
export { AmbiguousIdError, InvalidTransitionError, NotFoundError } from "./errors.ts";
export { computeConfidence, ROLE_FACTORS, SOURCE_WEIGHTS, type ConfidenceInput } from "./confidence.ts";
export { bigrams, contentHash, dice, normalizeName, normalizeText } from "./text.ts";
export { SHARED_ENTITY_BOOST, type InsertContext, type Neighbor, type NewMemory } from "./memories.ts";
