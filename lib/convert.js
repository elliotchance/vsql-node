'use strict';

// Converting parameters to the values that lib.execute binds, and the values
// of columns to JavaScript.

const lib = require('./binding');

const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

// SqlValue is a parameter that's sent as a particular SQL type, from numeric,
// date, time or timestamp. vsql can't cast a CHARACTER VARYING to these types,
// so a string can't be used for them.
class SqlValue {
  constructor(type, parameterType, columnSize, decimalDigits, value) {
    this.type = type;
    this.value = value;
    this.param = [lib.SQL_CHAR, parameterType, columnSize, decimalDigits, value];
    Object.freeze(this);
  }

  toString() {
    return this.value;
  }
}

const numericRe = /^([+-]?)(\d*)(?:\.(\d*))?$/;

// numeric is a NUMERIC with the precision and scale of its digits, from a
// string (such as "-12.50"), number or bigint.
function numeric(value) {
  const s = String(value);
  const m = (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint')
    && numericRe.exec(s);
  if (!m || (m[2] === '' && !m[3])) {
    throw new RangeError(`invalid NUMERIC: ${JSON.stringify(s)}`);
  }

  // vsql counts at least one digit before the decimal point (so 0.25 is
  // NUMERIC(3, 2)).
  const sign = m[1] === '-' ? '-' : '';
  const integer = m[2].replace(/^0+(?=\d)/, '') || '0';
  const fraction = m[3] || '';
  const precision = (integer.replace(/^0+/, '').length || 1) + fraction.length;

  return new SqlValue('NUMERIC', lib.SQL_NUMERIC, precision, fraction.length,
    sign + integer + (fraction && `.${fraction}`));
}

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const timeRe = /^(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/;
const timestampRe = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/;

function checkString(type, s, re) {
  const m = typeof s === 'string' && re.exec(s);
  if (!m) {
    throw new RangeError(`invalid ${type}: ${JSON.stringify(s)}`);
  }

  return m;
}

// offset is a time zone offset as vsql reads it (such as "+05:30"), from
// "Z", "+0530" or "+05:30".
function offset(s) {
  if (s === 'Z') {
    return '+00:00';
  }

  return s.length === 5 ? `${s.slice(0, 3)}:${s.slice(3)}` : s;
}

// date is a DATE, from "YYYY-MM-DD".
function date(s) {
  checkString('DATE', s, dateRe);

  return new SqlValue('DATE', lib.SQL_TYPE_DATE, s.length, 0, s);
}

// time is a TIME, from "HH:MM:SS" with up to 6 fractional digits. It's WITH
// TIME ZONE if it has an offset (such as "+05:30" or "Z").
function time(s) {
  const [, hms, fraction = '', zone] = checkString('TIME', s, timeRe);
  const value = hms + (fraction && `.${fraction}`);
  if (zone === undefined) {
    return new SqlValue('TIME', lib.SQL_TYPE_TIME, value.length, fraction.length, value);
  }

  const withZone = value + offset(zone);
  return new SqlValue('TIME WITH TIME ZONE', lib.SQL_TYPE_TIME_WITH_TIMEZONE, withZone.length,
    fraction.length, withZone);
}

// timestamp is a TIMESTAMP, from "YYYY-MM-DD HH:MM:SS" (or with a "T") with up
// to 6 fractional digits. It's WITH TIME ZONE if it has an offset (such as
// "+05:30" or "Z").
function timestamp(s) {
  const [, ymd, hms, fraction = '', zone] = checkString('TIMESTAMP', s, timestampRe);
  const value = `${ymd} ${hms}${fraction && `.${fraction}`}`;
  if (zone === undefined) {
    return new SqlValue('TIMESTAMP', lib.SQL_TYPE_TIMESTAMP, value.length, fraction.length, value);
  }

  const withZone = value + offset(zone);
  return new SqlValue('TIMESTAMP WITH TIME ZONE', lib.SQL_TYPE_TIMESTAMP_WITH_TIMEZONE,
    withZone.length, fraction.length, withZone);
}

// toParams is the parameters for lib.execute, from an array of values.
function toParams(params) {
  if (params === undefined) {
    return [];
  }
  if (!Array.isArray(params)) {
    throw new TypeError('the parameters must be an array (named parameters are not supported)');
  }

  return params.map((value, i) => {
    try {
      return toParam(value);
    } catch (e) {
      e.message = `parameter ${i + 1}: ${e.message}`;
      throw e;
    }
  });
}

// toParam is an array of [valueType, parameterType, columnSize, decimalDigits,
// value] for lib.execute. The value is sent as an SQL type, which is cast to
// the type it's used as. A columnSize of 0 for a string is its number of
// characters.
function toParam(value) {
  // The type doesn't matter for a NULL, since it's cast to the type it's used
  // as.
  if (value === null || value === undefined) {
    return [lib.SQL_CHAR, lib.SQL_VARCHAR, 1, 0, null];
  }

  switch (typeof value) {
    case 'boolean':
      return [lib.SQL_CHAR, lib.SQL_BOOLEAN, 0, 0, value ? 'TRUE' : 'FALSE'];

    case 'number':
      if (Number.isSafeInteger(value)) {
        return [lib.SQL_BIGINT, lib.SQL_BIGINT, 0, 0, value];
      }
      return [lib.SQL_DOUBLE, lib.SQL_DOUBLE, 0, 0, value];

    case 'bigint':
      if (value >= BIGINT_MIN && value <= BIGINT_MAX) {
        return [lib.SQL_BIGINT, lib.SQL_BIGINT, 0, 0, value];
      }
      return numeric(value).param;

    case 'string':
      return [lib.SQL_CHAR, lib.SQL_VARCHAR, 0, 0, value];

    default:
      break;
  }

  if (value instanceof SqlValue) {
    return value.param;
  }

  if (value instanceof Date) {
    const iso = Number.isNaN(value.getTime()) ? '' : value.toISOString();
    if (iso.length !== 24) {
      throw new RangeError(`invalid Date: ${value}`);
    }

    // "YYYY-MM-DDTHH:MM:SS.mmmZ" is "YYYY-MM-DD HH:MM:SS.mmm+00:00".
    return timestamp(iso).param;
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError("vsql doesn't have a binary type");
  }

  const type = typeof value === 'object' ? value.constructor?.name ?? 'object' : typeof value;
  throw new TypeError(`unsupported type ${type}`);
}

// A value WITH TIME ZONE ends with an offset such as "+0530", which is
// "+05:30" in ISO 8601 (and for Date.parse).
function withTimeZone(s) {
  return `${s.slice(0, -2)}:${s.slice(-2)}`;
}

// For each data type (from lib.describeCol): its name, how lib.fetch reads it
// (see binding.c) and the function that converts that to its JavaScript value
// (null if it doesn't need to be converted). A BIGINT is read as 'I', or 'b'
// for a connection with { bigint: true }.
const types = new Map([
  [lib.SQL_SMALLINT, ['SMALLINT', 'i', null]],
  [lib.SQL_INTEGER, ['INTEGER', 'i', null]],
  [lib.SQL_BIGINT, ['BIGINT', 'I', null]],
  [lib.SQL_REAL, ['REAL', 'r', null]],
  [lib.SQL_FLOAT, ['DOUBLE PRECISION', 'd', null]],
  [lib.SQL_DOUBLE, ['DOUBLE PRECISION', 'd', null]],
  [lib.SQL_DECIMAL, ['DECIMAL', 's', null]],
  [lib.SQL_NUMERIC, ['NUMERIC', 's', null]],
  [lib.SQL_CHAR, ['CHARACTER', 's', null]],
  [lib.SQL_VARCHAR, ['CHARACTER VARYING', 's', null]],
  [lib.SQL_BOOLEAN, ['BOOLEAN', 'o', null]],
  [lib.SQL_TYPE_DATE, ['DATE', 's', null]],
  [lib.SQL_TYPE_TIME, ['TIME', 's', null]],
  [lib.SQL_TYPE_TIME_WITH_TIMEZONE, ['TIME WITH TIME ZONE', 's', withTimeZone]],
  [lib.SQL_TYPE_TIMESTAMP, ['TIMESTAMP', 's', null]],
  [lib.SQL_TYPE_TIMESTAMP_WITH_TIMEZONE, ['TIMESTAMP WITH TIME ZONE', 's', withTimeZone]],
]);

module.exports = { SqlValue, numeric, date, time, timestamp, toParams, types };
