export interface SequentialExecutionSummary {
  attempted: number;
  succeeded: number;
  stoppedAtIndex: number | null;
}

export async function executeSequentially<T>(
  items: readonly T[],
  execute: (item: T, index: number) => Promise<boolean>
): Promise<SequentialExecutionSummary> {
  let succeeded = 0;

  for (let index = 0; index < items.length; index += 1) {
    const completed = await execute(items[index], index);
    if (!completed) {
      return {
        attempted: index + 1,
        succeeded,
        stoppedAtIndex: index
      };
    }
    succeeded += 1;
  }

  return {
    attempted: items.length,
    succeeded,
    stoppedAtIndex: null
  };
}
