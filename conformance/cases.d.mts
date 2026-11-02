export type ConformanceCase = { id: string; op: string; input: unknown; expected: unknown };
export function loadCases(): ConformanceCase[];
