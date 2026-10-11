// Minimal ambient types for ot-json1 (the JSONv1 OT type used by Wiz).
// Mirrors the type object shape registered in the LiveEditor bundle (module 411).
declare module "ot-json1" {
  export interface Json1Subtype {
    name: string;
    uri: string;
    create?: (data?: unknown) => unknown;
    apply?: (data: unknown, op: unknown) => unknown;
    compose?: (a: unknown, b: unknown) => unknown;
    diff?: (a: unknown, b: unknown) => unknown;
    transform?: (
      op: unknown,
      otherOp: unknown,
      direction: "left" | "right",
    ) => unknown;
    transformPosition?: (
      pos: number,
      op: unknown,
      direction: "left" | "right",
    ) => number;
    normalize?: (op: unknown) => unknown;
    isNoop?: (op: unknown) => boolean;
    checkValidOp?: (op: unknown) => void;
    invert?: (op: unknown) => unknown;
  }

  export interface Json1Type extends Json1Subtype {
    name: string;
    uri: string;
    registerSubtype(subtype: Json1Subtype): void;
    apply(data: unknown, op: unknown): unknown;
    transform(
      op: unknown,
      otherOp: unknown,
      direction: "left" | "right",
    ): unknown;
    normalize(op: unknown): unknown;
  }

  export function moveOp(from: (string | number)[], to: (string | number)[]): unknown[];

  export const type: Json1Type;
}
