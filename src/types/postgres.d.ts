declare module "postgres" {
  type SqlFragment = string;

  type Sql<T = unknown> = {
    <TRow = T>(): Sql<TRow>;
    <TRow = T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<TRow>;
    unsafe(sql: string): Promise<unknown> & SqlFragment;
    array(values: unknown[], typeId?: number): unknown[];
    json(value: unknown): unknown;
    begin<TResult>(fn: (sql: Sql<T>) => Promise<TResult>): Promise<TResult>;
    end(options?: { timeout?: number }): Promise<void>;
  };

  type Options<T extends Record<string, unknown> = {}> = {
    host?: string | string[];
    port?: number | number[];
    path?: string;
    database?: string;
    username?: string;
    password?: string;
    max?: number;
    ssl?: "require" | "allow" | "prefer" | "verify-full" | boolean | object;
    debug?: boolean | ((connection: number, query: string, parameters: unknown[]) => void);
    onnotice?: (notice: unknown) => void;
    prepare?: boolean;
    types?: T;
  };

  export default function postgres<T extends Record<string, unknown> = {}>(
    options?: Options<T>,
  ): Sql;
}
