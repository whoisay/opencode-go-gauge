/**
 * bun:sqlite 的最小类型声明。
 *
 * 只声明这个插件用到的三个成员，够 tsc 过就行。
 * 运行时由 OpenCode 的 Bun 提供，不需要打包。
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean })
    query(sql: string): { get(): unknown }
    close(): void
  }
}
