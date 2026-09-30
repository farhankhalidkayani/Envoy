declare module "safe-regex" {
  function safeRegex(pattern: string | RegExp, opts?: { limit?: number }): boolean;
  export default safeRegex;
}
