// The types of vsql-node (lib/index.js). See the README for how each SQL type
// is converted.

/** A value that can be a parameter. */
export type Parameter =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Date
  | SqlValue;

/** A column's value. A BIGINT is a bigint with { bigint: true }. */
export type Value = null | boolean | number | bigint | string;

/** A row, keyed by the column names (or an array, see Statement.raw). */
export type Row = Record<string, Value>;

export interface ConnectOptions {
  /** A BIGINT column is a bigint, instead of a number. */
  bigint?: boolean;
}

export interface Column {
  name: string;
  /** The SQL type, such as "INTEGER" or "CHARACTER VARYING". */
  type: string;
  nullable: boolean;
  /** The maximum length of a CHARACTER or CHARACTER VARYING. */
  length: number | null;
  /** The precision of a DECIMAL or NUMERIC. */
  precision: number | null;
  /** The scale of a DECIMAL or NUMERIC. */
  scale: number | null;
}

export interface RunResult {
  /** The number of rows that were inserted, updated or deleted. */
  changes: number;
}

/**
 * Opens a connection to a database file (which is created if it doesn't
 * exist), or ":memory:" for a database that only exists for the life of the
 * connection.
 */
export function connect(database: string, options?: ConnectOptions): Connection;

export class Connection {
  private constructor();

  /** The database, as given to connect. */
  readonly name: string;
  readonly bigint: boolean;
  readonly open: boolean;
  readonly inTransaction: boolean;

  /** Prepares a statement, with a "?" for each parameter. */
  prepare<R = Row>(sql: string): Statement<R>;

  run(sql: string, params?: Parameter[]): RunResult;
  get<R = Row>(sql: string, params?: Parameter[]): R | undefined;
  all<R = Row>(sql: string, params?: Parameter[]): R[];
  iterate<R = Row>(sql: string, params?: Parameter[]): IterableIterator<R>;

  /** Starts a transaction, which is ended by commit or rollback. */
  begin(): void;
  /** Commits the transaction, if there is one. */
  commit(): void;
  /** Rolls back the transaction, if there is one. */
  rollback(): void;
  /**
   * Calls fn in a transaction, which is committed when it returns (and its
   * value is returned), or rolled back if it throws.
   */
  transaction<T>(fn: () => T): T;

  /** Closes the connection and its statements, rolling back a transaction. */
  close(): void;
  [Symbol.dispose](): void;
}

export class Statement<R = Row> {
  private constructor();

  readonly connection: Connection;
  readonly sql: string;
  /** Whether the statement returns rows (certain once it's executed). */
  readonly reader: boolean;

  columns(): Column[];
  /** Makes each row an array, in the order of the columns. */
  raw(on?: true): Statement<Value[]>;
  raw(on: false): Statement<Row>;
  raw(on?: boolean): Statement<Value[] | Row>;

  run(params?: Parameter[]): RunResult;
  get(params?: Parameter[]): R | undefined;
  all(params?: Parameter[]): R[];
  iterate(params?: Parameter[]): IterableIterator<R>;

  close(): void;
  [Symbol.dispose](): void;
}

/** An error from vsql. */
export class VsqlError extends Error {
  readonly name: 'VsqlError';
  /** The SQLSTATE, such as "42P01". */
  readonly sqlstate: string;
  /** The same as sqlstate. */
  readonly code: string;
}

/** A parameter that's sent as a particular SQL type. */
export class SqlValue {
  private constructor();

  readonly type: string;
  readonly value: string;
  toString(): string;
}

/** A NUMERIC, from a string (such as "-12.50"), number or bigint. */
export function numeric(value: string | number | bigint): SqlValue;
/** A DATE, from "YYYY-MM-DD". */
export function date(value: string): SqlValue;
/** A TIME, from "HH:MM:SS[.ffffff][offset]". */
export function time(value: string): SqlValue;
/** A TIMESTAMP, from "YYYY-MM-DD HH:MM:SS[.ffffff][offset]" (or with a "T"). */
export function timestamp(value: string): SqlValue;
