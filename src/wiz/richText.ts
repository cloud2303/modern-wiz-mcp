// rich-text 子类型:包装 quill-delta 的 Delta。
// 对照 bundle 里 Io.type(entry r93381):数据就是 quill-delta ops 数组,
// apply = Delta.compose,transform = Delta.transform,transformCursor 用 Delta.transformPosition。
import Delta from "quill-delta";
import type { Json1Subtype } from "ot-json1";

function toDelta(value: unknown): Delta {
  return new Delta(value as any[]);
}

export const richTextSubtype: Json1Subtype = {
  name: "rich-text",
  uri: "http://sharejs.org/types/rich-text/v1",

  create(data?: unknown) {
    return data == null ? [] : data;
  },
  apply(data: unknown, op: unknown) {
    return toDelta(data).compose(toDelta(op)).ops;
  },
  compose(a: unknown, b: unknown) {
    return toDelta(a).compose(toDelta(b)).ops;
  },
  diff(a: unknown, b: unknown) {
    return toDelta(a).diff(toDelta(b)).ops;
  },
  // ot-json1 子类型约定 transform(op, otherOp, direction):
  // 在 otherOp 已经应用的前提下变换 op → otherOp.transform(op, priority)。
  transform(op: unknown, otherOp: unknown, direction: "left" | "right") {
    return toDelta(otherOp).transform(toDelta(op), direction === "left").ops;
  },
  transformPosition(pos: number, op: unknown, direction: "left" | "right") {
    return toDelta(op).transformPosition(pos, direction !== "left");
  },
  normalize(op: unknown) {
    return op;
  },
  isNoop(op: unknown) {
    return !op || (Array.isArray(op) && op.length === 0);
  },
  checkValidOp(_op: unknown) {
    // quill-delta 无法严格校验任意 op;由上层 Delta 应用时抛错。
  },
};
