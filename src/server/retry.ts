/** Runs one recovery attempt without turning a transient helper failure into a permanent disable. */
export async function runWithSingleRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}
