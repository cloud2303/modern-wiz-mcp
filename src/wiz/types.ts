// Wiz 文档 / block 数据模型。
// 字段来源:docs/wiz-websocket-protocol.md + index.js bundle 逆向(entry 的 block 模型)。

export const BLOCK_TYPE = {
  TEXT: "text",
  HEADING: "heading",
  LIST: "list",
  TABLE: "table",
  EMBED: "embed",
  CODE_LINE: "code-line",
  CODE: "code",
} as const;

export type BlockType = (typeof BLOCK_TYPE)[keyof typeof BLOCK_TYPE];

/** quill-delta op(block.text 的数组元素)。 */
export type TextSegment =
  | { insert: string; attributes?: Record<string, unknown> }
  | { insert: number | object; attributes?: Record<string, unknown> }
  | { retain?: number; attributes?: Record<string, unknown> };

export interface WizBlock {
  id: string;
  type: BlockType;
  /** 文本块专用:quill-delta ops */
  text?: TextSegment[];
  /** code 块:指向 code-line 容器 id */
  children?: string[];
  heading?: number;
  quoted?: boolean;
  level?: number;
  align?: string;
  padding?: string;
  comments?: string[];
  language?: string | null;
  ordered?: boolean;
  groupId?: string;
  start?: number;
  embedType?: string;
  embedData?: Record<string, unknown>;
  code?: string;
  disableWrap?: boolean;
  markerData?: unknown;
  markerWidth?: number;
  markerExpired?: boolean;
  [key: string]: unknown;
}

export interface WizCodeLine {
  id: string;
  type: "code-line";
  text?: TextSegment[];
  quoted?: boolean;
}

export interface WizComment {
  id: string;
  groupId?: string;
  userId?: string;
  displayName?: string;
  avatarUrl?: string;
  abstract?: string;
  blocks?: WizBlock[];
  created?: number;
  modified?: number;
  [key: string]: unknown;
}

export interface WizMeta {
  title?: string;
  version?: number;
  ctime?: number;
  mtime?: number;
  updatedBy?: { userId: string; displayName: string };
  [key: string]: unknown;
}

/**
 * 快照根对象。除 blocks/comments/meta 外,嵌套容器(code-line 数组等)
 * 以容器 id 作为顶层 key 存放。
 */
export interface WizDoc {
  blocks: WizBlock[];
  comments?: Record<string, WizComment>;
  meta?: WizMeta;
  authors?: string[];
  commentators?: string[];
  [containerId: string]: unknown;
}
