// Minimal ambient types for the sharedb 1.x client (sharedb/lib/client).
// We import from sharedb/lib/client (NOT the main entry, which is server-side in 1.x).
// @types/sharedb on npm targets v6 and does not match this client API.
declare module "sharedb/lib/client/index.js" {
  export interface Listenable {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
  }

  export interface Types {
    map: Record<string, unknown>;
    defaultType: unknown;
    register(type: unknown): void;
  }

  export class Doc implements Listenable {
    connection: Connection;
    collection: string;
    id: string;
    version: number | null;
    type: unknown;
    data: unknown;

    fetch(callback?: (err: Error | null) => void): void;
    subscribe(callback?: (err: Error | null) => void): void;
    unsubscribe(callback?: (err: Error | null) => void): void;
    submitOp(
      op: unknown,
      options?: unknown,
      callback?: (err: Error | null) => void,
    ): void;
    create(data?: unknown, type?: string, callback?: (err: Error | null) => void): void;
    del(callback?: (err: Error | null) => void): void;
    destroy(callback?: (err: Error | null) => void): void;
    whenNothingPending(callback: () => void): void;
    hasPending(): boolean;
    hasWritePending(): boolean;
    pause(): void;
    resume(): void;

    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
  }

  export class Connection implements Listenable {
    id: string | null;
    seq: number;
    state: string;
    canSend: boolean;
    collections: Record<string, Record<string, Doc>>;

    constructor(socket: unknown);
    get(collection: string, id: string): Doc;
    getExisting(collection: string, id: string): Doc | undefined;
    getPresence(channel: string): Presence;
    getDocPresence(collection: string, id: string): Presence;
    send(message: Record<string, unknown>): void;
    close(): void;

    // Wiz adapter hooks: prototype methods overridden per instance.
    // eslint-disable-next-line @typescript-eslint/ban-types
    _initializeHandshake: () => void;
    handleMessage: (message: any) => void;

    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
  }

  export class LocalPresence implements Listenable {
    presence: Presence;
    presenceId: string;
    value: unknown;
    submit(value: unknown, callback?: (err: Error | null) => void): void;
    destroy(callback?: (err: Error | null) => void): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
  }

  export class Presence implements Listenable {
    connection: Connection;
    channel: string;
    wantSubscribe: boolean;
    subscribed: boolean;
    remotePresences: Record<string, unknown>;
    subscribe(callback?: (err: Error | null) => void): void;
    unsubscribe(callback?: (err: Error | null) => void): void;
    create(localPresenceId?: string): LocalPresence;
    destroy(presence: LocalPresence, callback?: (err: Error | null) => void): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
  }

  export const types: Types;
  export const logger: unknown;
}
