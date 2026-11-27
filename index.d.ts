// The types of vsql-node (lib/index.js). See the README for how each SQL type
// is converted.

/// <reference types="node" />

/** A value that can be a parameter. */
export type Parameter =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Date
  | SqlValue
  /** A binary string: the octets of any view (such as a Buffer) or buffer. */
  | ArrayBufferView
  | ArrayBuffer
  | SharedArrayBuffer;

/**
 * A column's value. A BIGINT is a bigint with { bigint: true }, and a binary
 * string is a Buffer.
 */
export type Value = null | boolean | number | bigint | string | Buffer;

/** A row, keyed by the column names (or an array, see Statement.raw). */
export type Row = Record<string, Value>;

export interface ConnectOptions {
  /** A BIGINT column is a bigint, instead of a number. */
  bigint?: boolean;
}

/** The type of a column or parameter. */
export interface TypeInfo {
  /** The SQL type, such as "INTEGER" or "INTERVAL YEAR TO MONTH". */
  type: string;
  nullable: boolean;
  /**
   * The maximum length of a CHARACTER or CHARACTER VARYING (in characters), or
   * a BINARY or BINARY VARYING (in octets).
   */
  length: number | null;
  /**
   * The precision of a DECIMAL, NUMERIC or DECFLOAT, the fractional seconds
   * precision of a TIME or TIMESTAMP (with or without a time zone), or the
   * leading field precision of an interval.
   */
  precision: number | null;
  /**
   * The scale of a DECIMAL or NUMERIC, or the fractional seconds precision of
   * an interval that ends with SECOND.
   */
  scale: number | null;
}

export interface Column extends TypeInfo {
  name: string;
  /**
   * The key of the rows that the column is part of, if vsql knows it: its
   * PRIMARY KEY, or a PREFERRED key (such as a UNIQUE NOT NULL column).
   */
  key: 'PRIMARY' | 'PREFERRED' | null;
}

/** A dynamic parameter, see Statement.parameters. */
export interface ParameterInfo extends Omit<TypeInfo, 'type'> {
  /** null if vsql doesn't know it until the statement is executed. */
  type: string | null;
}

export type IsolationLevel =
  | 'READ UNCOMMITTED'
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

export interface TransactionOptions {
  /** A READ ONLY transaction (it's READ WRITE by default). */
  readOnly?: boolean;
  /**
   * "READ COMMITTED" by default. vsql runs REPEATABLE READ as SERIALIZABLE,
   * and READ UNCOMMITTED (which must be readOnly) as READ COMMITTED.
   */
  isolationLevel?: IsolationLevel;
}

/** The version of vsql and how it was built, see Connection.info. */
export interface Info {
  /** "vsql". */
  dbmsName: string;
  /** Such as "01.07.0058". */
  dbmsVersion: string;
  /** Such as "v1.7.58", or "" if it isn't a release. */
  buildVersion: string;
  /** The git commit, or "" if it isn't a release. */
  buildCommit: string;
  /** Such as "2026-11-26" (UTC). */
  buildDate: string;
  /** The version of V that built it, such as "0.5.2". */
  buildVVersion: string;
  /** The commit of V that built it. */
  buildVCommit: string;
  /** Such as "clang". */
  buildCCompiler: string;
  /** Such as "macos". */
  operatingSystem: string;
  /** Such as "arm64". */
  machine: string;
  /** The file format version needed to read the database (0 for :memory:). */
  fileReadVersion: number;
  /** The file format version needed to write the database (0 for :memory:). */
  fileWriteVersion: number;
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
  /**
   * Whether there's a transaction. It's false after vsql rolls back the
   * transaction (such as for a 40001 serialization failure).
   */
  readonly inTransaction: boolean;

  /** Prepares a statement, with a "?" for each parameter. */
  prepare<R = Row>(sql: string): Statement<R>;

  run(sql: string, params?: Parameter[]): RunResult;
  get<R = Row>(sql: string, params?: Parameter[]): R | undefined;
  all<R = Row>(sql: string, params?: Parameter[]): R[];
  iterate<R = Row>(sql: string, params?: Parameter[]): IterableIterator<R>;

  /** Starts a transaction, which is ended by commit or rollback. */
  begin(options?: TransactionOptions): void;
  /** Commits the transaction, if there is one. */
  commit(): void;
  /**
   * Rolls back the transaction, if there is one. With the name of a savepoint
   * (an identifier, like in SQL), it only rolls back to that savepoint.
   */
  rollback(savepoint?: string): void;
  /**
   * Makes a savepoint in the transaction. The name is an identifier, like in
   * SQL. It throws a TypeError if there's no transaction.
   */
  savepoint(name: string): void;
  /**
   * Releases a savepoint (and the savepoints after it), keeping what came
   * after it. It throws a TypeError if there's no transaction.
   */
  release(name: string): void;
  /**
   * Calls fn in a transaction, which is committed when it returns (and its
   * value is returned), or rolled back if it throws. In another transaction,
   * it's a savepoint instead (and it can't have options). fn can't call commit
   * or rollback (without a savepoint), which throw a TypeError. If vsql rolls
   * back the transaction and fn catches the error, the statements after it,
   * and transaction itself, throw a TypeError.
   */
  transaction<T>(fn: () => T, options?: TransactionOptions): T;

  /** The version of vsql and how it was built. */
  info(): Info;

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

  /** Describes each column, as of the last execution (or when prepared). */
  columns(): Column[];
  /** Describes each parameter ("?"), from where it's used. */
  parameters(): ParameterInfo[];
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
  /** The constraint that was violated. */
  readonly constraintCatalog?: string;
  readonly constraintSchema?: string;
  readonly constraintName?: string;
  /** The table (or the table of the constraint). */
  readonly catalogName?: string;
  readonly schemaName?: string;
  readonly tableName?: string;
  /** The column, such as for an unknown column. */
  readonly columnName?: string;
  /** The cursor. */
  readonly cursorName?: string;
  /** Whether vsql raised more conditions than it kept. */
  readonly more: boolean;
  /** The other conditions that vsql raised with the error (usually none). */
  readonly diagnostics: Diagnostic[];
}

/** A condition that vsql raised with an error. */
export interface Diagnostic {
  /** The SQLSTATE, such as "01003". */
  readonly sqlstate: string;
  readonly message: string;
  readonly constraintCatalog?: string;
  readonly constraintSchema?: string;
  readonly constraintName?: string;
  readonly catalogName?: string;
  readonly schemaName?: string;
  readonly tableName?: string;
  readonly columnName?: string;
  readonly cursorName?: string;
}

/**
 * A warning from vsql (such as "01003" when a NULL is eliminated from SUM),
 * which is given to process.emitWarning.
 */
export class VsqlWarning extends Error {
  readonly name: 'VsqlWarning';
  /** The SQLSTATE, such as "01003". */
  readonly sqlstate: string;
  /** The same as sqlstate. */
  readonly code: string;
  readonly constraintCatalog?: string;
  readonly constraintSchema?: string;
  readonly constraintName?: string;
  readonly catalogName?: string;
  readonly schemaName?: string;
  readonly tableName?: string;
  readonly columnName?: string;
  readonly cursorName?: string;
}

/**
 * A parameter that's sent as a particular SQL type, made by numeric, date, time
 * or timestamp (the constructor throws a TypeError).
 */
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
