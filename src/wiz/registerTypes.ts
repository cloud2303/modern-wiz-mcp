// 注册 Wiz 需要的 OT 类型(幂等,模块加载时执行一次)。
// - json1 类型注册进 sharedb.types,name 覆盖为 "ot-json1"(与 bundle 一致)。
// - rich-text 子类型注册进 json1,文本块数据用 quill-delta ops。
import * as otJson1 from "ot-json1";
import { types } from "sharedb/lib/client/index.js";
import { richTextSubtype } from "./richText.js";

let registered = false;

export function registerWizTypes(): void {
  if (registered) return;
  registered = true;

  const json1 = otJson1.type as unknown as { name: string };
  json1.name = "ot-json1";
  otJson1.type.registerSubtype(richTextSubtype);
  types.register(otJson1.type);
}
