/** Files at or below this size travel with the chat request as data URLs. */
export const MAX_INLINE_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** Larger files stream to the local attachment store and are referenced by path. */
export const MAX_PATH_ATTACHMENT_BYTES = 512 * 1024 * 1024;
