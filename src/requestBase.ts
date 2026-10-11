import { AsyncLocalStorage } from "node:async_hooks";

export const requestBase = new AsyncLocalStorage<string>();
