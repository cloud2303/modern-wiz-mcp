/** 云端数据的读取边界：组件和命令共用校验后的值。 */
export interface ReadingCardData {
  title: string;
  book: string;
  current: number;
  target: number;
}

export function readReadingCardData(data: Record<string, unknown>): ReadingCardData {
  const integer = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(9999, Math.floor(value))) : fallback;
  const target = Math.max(1, integer(data.target, 12));
  return {
    title: typeof data.title === "string" ? data.title : "阅读计划",
    book: typeof data.book === "string" ? data.book : "",
    current: Math.min(target, integer(data.current, 0)),
    target,
  };
}
