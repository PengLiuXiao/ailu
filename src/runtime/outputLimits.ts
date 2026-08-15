/**
 * Runtime output must remain safely below the durable V2 message-content
 * ceiling. The remaining MiB is reserved for the terminal diagnostic and any
 * small coordinator-authored fallback text.
 */
export const MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES = 3 * 1_024 * 1_024;
