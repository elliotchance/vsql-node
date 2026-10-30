// binding.c is the vsql addon, the only code that calls libvsql (see
// libvsql.h), which is compiled into the addon from the amalgamation by
// binding.gyp. Each function is a thin wrapper around a libvsql routine, with
// handles as numbers. Everything else (such as converting values) is in
// JavaScript (see lib).
//
// The functions are synchronous: libvsql runs on the thread that called it.
//
// When a routine fails, the error is made by the function given to
// setErrorFactory, from the SQLSTATE and message of the first diagnostic
// record.

#include <stdlib.h>
#include <string.h>

#include <node_api.h>

#include "libvsql.h"

// See runtime.c.
void vsql_gc_after_node_init(void);

// The largest integer that a number can hold exactly (2^53 - 1).
#define MAX_SAFE_INTEGER 9007199254740991LL

// The data of each instance of the addon (one for each thread that loads it).
typedef struct {
  napi_ref error_factory;
} instance;

// NAPI_CALL returns NULL from the function if a Node-API call fails, which
// has thrown an exception.
#define NAPI_CALL(call)                                                        \
  do {                                                                         \
    if ((call) != napi_ok) {                                                   \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

// throw_error throws the error for an SQLSTATE and message.
static void throw_error(napi_env env, const char *sqlstate, const char *message, size_t length) {
  instance *inst = NULL;
  napi_value factory = NULL;
  napi_get_instance_data(env, (void **)&inst);
  if (inst == NULL || inst->error_factory == NULL ||
      napi_get_reference_value(env, inst->error_factory, &factory) != napi_ok || factory == NULL) {
    napi_throw_error(env, sqlstate, message);
    return;
  }

  napi_value args[2], global, err;
  if (napi_create_string_utf8(env, sqlstate, NAPI_AUTO_LENGTH, &args[0]) != napi_ok ||
      napi_create_string_utf8(env, message, length, &args[1]) != napi_ok ||
      napi_get_global(env, &global) != napi_ok ||
      napi_call_function(env, global, factory, 2, args, &err) != napi_ok) {
    return;
  }
  napi_throw(env, err);
}

// check returns 0 for a return code that isn't an error (SQL_NO_DATA isn't),
// otherwise it throws the error from the diagnostics of the handle and returns
// -1.
static int check(napi_env env, SQLRETURN rc, SQLSMALLINT handle_type, SQLINTEGER handle) {
  switch (rc) {
  case SQL_SUCCESS:
  case SQL_SUCCESS_WITH_INFO:
  case SQL_NO_DATA:
    return 0;
  case SQL_INVALID_HANDLE:
    throw_error(env, "HY000", "invalid handle", NAPI_AUTO_LENGTH);
    return -1;
  }

  SQLCHAR sqlstate[6];
  SQLSMALLINT size = 512, length = 0;
  SQLCHAR *message = malloc(size);
  for (;;) {
    if (message == NULL) {
      napi_throw_error(env, NULL, "out of memory");
      return -1;
    }

    rc = SQLGetDiagRec(handle_type, handle, 1, sqlstate, NULL, message, size, &length);
    if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO) {
      free(message);
      throw_error(env, "HY000", "unknown error", NAPI_AUTO_LENGTH);
      return -1;
    }

    // The message was truncated.
    if (length >= size) {
      size = length + 1;
      free(message);
      message = malloc(size);
      continue;
    }

    throw_error(env, (const char *)sqlstate, (const char *)message, length);
    free(message);
    return -1;
  }
}

// CHECK returns NULL from the function if a libvsql routine fails.
#define CHECK(handle_type, handle, routine)                                    \
  do {                                                                         \
    if (check(env, (routine), (handle_type), (handle)) < 0) {                  \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

// args gets the arguments of a function, which must have at least n.
static int args(napi_env env, napi_callback_info info, size_t n, napi_value *argv) {
  size_t argc = n;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
    return -1;
  }
  if (argc < n) {
    napi_throw_type_error(env, NULL, "not enough arguments");
    return -1;
  }

  return 0;
}

// ARGS gets the arguments of a function, or returns NULL.
#define ARGS(n)                                                                \
  napi_value argv[n];                                                          \
  if (args(env, info, (n), argv) < 0) {                                        \
    return NULL;                                                               \
  }

// get_string returns a string as UTF-8 (null terminated), which must be freed,
// or NULL if it isn't a string (which has thrown an exception).
static char *get_string(napi_env env, napi_value value, size_t *length) {
  if (napi_get_value_string_utf8(env, value, NULL, 0, length) != napi_ok) {
    return NULL;
  }

  char *s = malloc(*length + 1);
  if (s == NULL) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  if (napi_get_value_string_utf8(env, value, s, *length + 1, length) != napi_ok) {
    free(s);
    return NULL;
  }

  return s;
}

static napi_value undefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value number(napi_env env, double n) {
  napi_value result;
  NAPI_CALL(napi_create_double(env, n, &result));
  return result;
}

// setErrorFactory(factory)
static napi_value set_error_factory(napi_env env, napi_callback_info info) {
  ARGS(1);
  instance *inst = NULL;
  NAPI_CALL(napi_get_instance_data(env, (void **)&inst));
  if (inst->error_factory != NULL) {
    napi_delete_reference(env, inst->error_factory);
    inst->error_factory = NULL;
  }
  NAPI_CALL(napi_create_reference(env, argv[0], 1, &inst->error_factory));

  return undefined(env);
}

// allocHandle(handleType, inputHandle) -> handle
static napi_value alloc_handle(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t handle_type, input;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &handle_type));
  NAPI_CALL(napi_get_value_int32(env, argv[1], &input));

  SQLINTEGER output = 0;
  SQLRETURN rc = SQLAllocHandle((SQLSMALLINT)handle_type, input, &output);

  // An environment doesn't have an input handle with diagnostics.
  if (handle_type == SQL_HANDLE_ENV) {
    if (rc != SQL_SUCCESS) {
      throw_error(env, "HY001", "can't allocate an environment", NAPI_AUTO_LENGTH);
      return NULL;
    }
  } else {
    CHECK(handle_type == SQL_HANDLE_DBC ? SQL_HANDLE_ENV : SQL_HANDLE_DBC, input, rc);
  }

  return number(env, output);
}

// freeHandle(handleType, handle)
static napi_value free_handle(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t handle_type, handle;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &handle_type));
  NAPI_CALL(napi_get_value_int32(env, argv[1], &handle));

  CHECK(handle_type, handle, SQLFreeHandle((SQLSMALLINT)handle_type, handle));
  return undefined(env);
}

// connect(dbc, name)
static napi_value connect(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t dbc;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &dbc));
  size_t length;
  char *name = get_string(env, argv[1], &length);
  if (name == NULL) {
    return NULL;
  }

  SQLRETURN rc = SQLConnect(dbc, (SQLCHAR *)name, (SQLSMALLINT)length, NULL, 0, NULL, 0);
  free(name);
  CHECK(SQL_HANDLE_DBC, dbc, rc);
  return undefined(env);
}

// disconnect(dbc)
static napi_value disconnect(napi_env env, napi_callback_info info) {
  ARGS(1);
  int32_t dbc;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &dbc));

  CHECK(SQL_HANDLE_DBC, dbc, SQLDisconnect(dbc));
  return undefined(env);
}

// setAutocommit(dbc, on)
static napi_value set_autocommit(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t dbc;
  bool on;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &dbc));
  NAPI_CALL(napi_get_value_bool(env, argv[1], &on));

  // libvsql reads the value after SQLSetConnectAttr returns, so it can't be
  // on the stack.
  static SQLINTEGER autocommit_on = SQL_AUTOCOMMIT_ON, autocommit_off = SQL_AUTOCOMMIT_OFF;
  CHECK(SQL_HANDLE_DBC, dbc,
        SQLSetConnectAttr(dbc, SQL_ATTR_AUTOCOMMIT,
                          on ? (SQLPOINTER)&autocommit_on : (SQLPOINTER)&autocommit_off, 0));
  return undefined(env);
}

// startTran(dbc, accessMode, isolationLevel)
static napi_value start_tran(napi_env env, napi_callback_info info) {
  ARGS(3);
  int32_t dbc, access_mode, isolation_level;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &dbc));
  NAPI_CALL(napi_get_value_int32(env, argv[1], &access_mode));
  NAPI_CALL(napi_get_value_int32(env, argv[2], &isolation_level));

  CHECK(SQL_HANDLE_DBC, dbc, SQLStartTran(SQL_HANDLE_DBC, dbc, access_mode, isolation_level));
  return undefined(env);
}

// endTran(dbc, commit)
static napi_value end_tran(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t dbc;
  bool commit;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &dbc));
  NAPI_CALL(napi_get_value_bool(env, argv[1], &commit));

  CHECK(SQL_HANDLE_DBC, dbc, SQLEndTran(SQL_HANDLE_DBC, dbc, commit ? SQL_COMMIT : SQL_ROLLBACK));
  return undefined(env);
}

// execDirect(stmt, query)
static napi_value exec_direct(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t stmt;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &stmt));
  size_t length;
  char *query = get_string(env, argv[1], &length);
  if (query == NULL) {
    return NULL;
  }

  SQLRETURN rc = SQLExecDirect(stmt, (SQLCHAR *)query, (SQLINTEGER)length);
  free(query);
  CHECK(SQL_HANDLE_STMT, stmt, rc);
  return undefined(env);
}

// prepare(stmt, query)
static napi_value prepare(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t stmt;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &stmt));
  size_t length;
  char *query = get_string(env, argv[1], &length);
  if (query == NULL) {
    return NULL;
  }

  SQLRETURN rc = SQLPrepare(stmt, (SQLCHAR *)query, (SQLINTEGER)length);
  free(query);
  CHECK(SQL_HANDLE_STMT, stmt, rc);
  return undefined(env);
}

// A parameter's value, which must stay allocated until SQLExecute has read it.
typedef struct {
  SQLBIGINT i;
  SQLDOUBLE d;
  char *s;
  SQLINTEGER ind;
} param;

// characters is the number of characters (code points) in UTF-8.
static SQLINTEGER characters(const char *s, size_t length) {
  SQLINTEGER n = 0;
  for (size_t i = 0; i < length; i++) {
    // Each character has one byte that isn't a continuation byte (10xxxxxx).
    if (((unsigned char)s[i] & 0xC0) != 0x80) {
      n++;
    }
  }

  return n;
}

// bind_param binds one parameter, an array of [valueType, parameterType,
// columnSize, decimalDigits, value], where the value is null, a number or
// bigint (SQL_BIGINT), a number (SQL_DOUBLE) or a string (SQL_CHAR). A
// columnSize of 0 for a string is its number of characters (at least 1).
static int bind_param(napi_env env, SQLINTEGER stmt, SQLSMALLINT n, napi_value array, param *p) {
  napi_value fields[5];
  for (uint32_t i = 0; i < 5; i++) {
    if (napi_get_element(env, array, i, &fields[i]) != napi_ok) {
      return -1;
    }
  }

  int32_t value_type, parameter_type, column_size, decimal_digits;
  if (napi_get_value_int32(env, fields[0], &value_type) != napi_ok ||
      napi_get_value_int32(env, fields[1], &parameter_type) != napi_ok ||
      napi_get_value_int32(env, fields[2], &column_size) != napi_ok ||
      napi_get_value_int32(env, fields[3], &decimal_digits) != napi_ok) {
    return -1;
  }

  napi_valuetype type;
  if (napi_typeof(env, fields[4], &type) != napi_ok) {
    return -1;
  }

  SQLPOINTER pointer = NULL;
  SQLINTEGER buffer_length = 0;
  if (type == napi_null || type == napi_undefined) {
    p->ind = SQL_NULL_DATA;
  } else if (value_type == SQL_BIGINT) {
    if (type == napi_bigint) {
      bool lossless;
      if (napi_get_value_bigint_int64(env, fields[4], &p->i, &lossless) != napi_ok) {
        return -1;
      }
    } else if (napi_get_value_int64(env, fields[4], &p->i) != napi_ok) {
      return -1;
    }
    pointer = &p->i;
    buffer_length = sizeof(SQLBIGINT);
  } else if (value_type == SQL_DOUBLE) {
    if (napi_get_value_double(env, fields[4], &p->d) != napi_ok) {
      return -1;
    }
    pointer = &p->d;
    buffer_length = sizeof(SQLDOUBLE);
  } else {
    size_t length;
    p->s = get_string(env, fields[4], &length);
    if (p->s == NULL) {
      return -1;
    }
    if (column_size == 0) {
      column_size = characters(p->s, length);
      if (column_size == 0) {
        column_size = 1;
      }
    }
    pointer = p->s;
    buffer_length = (SQLINTEGER)length + 1;
    p->ind = (SQLINTEGER)length;
  }

  return check(env,
               SQLBindParameter(stmt, n, SQL_PARAM_MODE_IN, (SQLSMALLINT)value_type,
                                (SQLSMALLINT)parameter_type, column_size,
                                (SQLSMALLINT)decimal_digits, pointer, buffer_length, &p->ind),
               SQL_HANDLE_STMT, stmt);
}

// execute(stmt, params) executes the prepared statement with the parameters
// (see bind_param), which are bound for this execution only.
static napi_value execute(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t stmt;
  uint32_t n;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &stmt));
  NAPI_CALL(napi_get_array_length(env, argv[1], &n));

  param *params = calloc(n ? n : 1, sizeof(param));
  if (params == NULL) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }

  napi_value result = NULL;
  for (uint32_t i = 0; i < n; i++) {
    napi_value array;
    if (napi_get_element(env, argv[1], i, &array) != napi_ok ||
        bind_param(env, stmt, (SQLSMALLINT)(i + 1), array, &params[i]) < 0) {
      goto done;
    }
  }

  if (check(env, SQLExecute(stmt), SQL_HANDLE_STMT, stmt) == 0) {
    result = undefined(env);
  }

done:
  // The values are freed, so they can't stay bound for the next execution.
  if (n > 0) {
    SQLFreeStmt(stmt, SQL_RESET_PARAMS);
  }
  for (uint32_t i = 0; i < n; i++) {
    free(params[i].s);
  }
  free(params);

  return result;
}

// rowCount(stmt) -> number
static napi_value row_count(napi_env env, napi_callback_info info) {
  ARGS(1);
  int32_t stmt;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &stmt));

  SQLINTEGER n = 0;
  CHECK(SQL_HANDLE_STMT, stmt, SQLRowCount(stmt, &n));
  return number(env, n);
}

// numResultCols(stmt) -> number
static napi_value num_result_cols(napi_env env, napi_callback_info info) {
  ARGS(1);
  int32_t stmt;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &stmt));

  SQLSMALLINT n = 0;
  CHECK(SQL_HANDLE_STMT, stmt, SQLNumResultCols(stmt, &n));
  return number(env, n);
}

// describeCol(stmt, n) -> [name, dataType, columnSize, decimalDigits,
// nullable]
static napi_value describe_col(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t stmt, n;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &stmt));
  NAPI_CALL(napi_get_value_int32(env, argv[1], &n));

  SQLSMALLINT size = 129, length = 0, data_type = 0, decimal_digits = 0, nullable = 0;
  SQLINTEGER column_size = 0;
  for (;;) {
    SQLCHAR *name = malloc(size);
    if (name == NULL) {
      napi_throw_error(env, NULL, "out of memory");
      return NULL;
    }

    SQLRETURN rc = SQLDescribeCol(stmt, (SQLSMALLINT)n, name, size, &length, &data_type,
                                  &column_size, &decimal_digits, &nullable);
    if (check(env, rc, SQL_HANDLE_STMT, stmt) < 0) {
      free(name);
      return NULL;
    }

    // The name was truncated.
    if (length >= size) {
      size = length + 1;
      free(name);
      continue;
    }

    napi_value result, values[5];
    napi_status status = napi_create_string_utf8(env, (const char *)name, length, &values[0]);
    free(name);
    NAPI_CALL(status);
    NAPI_CALL(napi_create_int32(env, data_type, &values[1]));
    NAPI_CALL(napi_create_int32(env, column_size, &values[2]));
    NAPI_CALL(napi_create_int32(env, decimal_digits, &values[3]));
    NAPI_CALL(napi_create_int32(env, nullable, &values[4]));
    NAPI_CALL(napi_create_array_with_length(env, 5, &result));
    for (uint32_t i = 0; i < 5; i++) {
      NAPI_CALL(napi_set_element(env, result, i, values[i]));
    }

    return result;
  }
}

// closeCursor(stmt)
static napi_value close_cursor(napi_env env, napi_callback_info info) {
  ARGS(1);
  int32_t stmt;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &stmt));

  CHECK(SQL_HANDLE_STMT, stmt, SQLCloseCursor(stmt));
  return undefined(env);
}

// get_chars reads a column as SQL_CHAR into a string, or null. A string that
// doesn't fit in the buffer is read in pieces, into a buffer that's the size of
// the rest of it.
static napi_value get_chars(napi_env env, SQLINTEGER stmt, SQLSMALLINT n) {
  char small[256];
  char *buf = small, *large = NULL;
  SQLINTEGER size = sizeof(small), ind = 0;
  size_t length = 0;
  for (;;) {
    SQLRETURN rc = SQLGetData(stmt, n, SQL_CHAR, buf + length, size - (SQLINTEGER)length, &ind);
    if (check(env, rc, SQL_HANDLE_STMT, stmt) < 0) {
      free(large);
      return NULL;
    }
    if (ind == SQL_NULL_DATA) {
      free(large);
      napi_value result;
      NAPI_CALL(napi_get_null(env, &result));
      return result;
    }

    // The rest of the string (ind) didn't fit, so the buffer has a null
    // terminated piece of it.
    if (rc == SQL_SUCCESS_WITH_INFO && ind >= size - (SQLINTEGER)length) {
      size_t piece = strlen(buf + length);
      size_t new_size = length + piece + (size_t)ind + 1;
      char *grown = malloc(new_size);
      if (grown == NULL) {
        free(large);
        napi_throw_error(env, NULL, "out of memory");
        return NULL;
      }
      memcpy(grown, buf, length + piece);
      free(large);
      buf = large = grown;
      length += piece;
      size = (SQLINTEGER)new_size;
      continue;
    }

    napi_value result;
    napi_status status = napi_create_string_utf8(env, buf, length + ind, &result);
    free(large);
    NAPI_CALL(status);
    return result;
  }
}

// get_value reads a column of the current row (see fetch for the kinds).
static napi_value get_value(napi_env env, SQLINTEGER stmt, SQLSMALLINT column, char kind) {
  SQLINTEGER ind = 0;
  napi_value result;
  switch (kind) {
  case 'i':
  case 'I':
  case 'b': {
    SQLBIGINT v = 0;
    CHECK(SQL_HANDLE_STMT, stmt, SQLGetData(stmt, column, SQL_BIGINT, &v, sizeof(v), &ind));
    if (ind == SQL_NULL_DATA) {
      break;
    }
    if (kind == 'b') {
      NAPI_CALL(napi_create_bigint_int64(env, v, &result));
      return result;
    }
    if (v > MAX_SAFE_INTEGER || v < -MAX_SAFE_INTEGER) {
      napi_throw_range_error(env, NULL,
                             "a BIGINT is out of the range of a number, connect with "
                             "{ bigint: true } to read it as a bigint");
      return NULL;
    }
    return number(env, (double)v);
  }
  case 'd': {
    SQLDOUBLE v = 0;
    CHECK(SQL_HANDLE_STMT, stmt, SQLGetData(stmt, column, SQL_DOUBLE, &v, sizeof(v), &ind));
    if (ind == SQL_NULL_DATA) {
      break;
    }
    return number(env, v);
  }
  case 'r': {
    SQLREAL v = 0;
    CHECK(SQL_HANDLE_STMT, stmt, SQLGetData(stmt, column, SQL_REAL, &v, sizeof(v), &ind));
    if (ind == SQL_NULL_DATA) {
      break;
    }
    return number(env, v);
  }
  case 'o': {
    // TRUE or FALSE.
    char v[6] = {0};
    CHECK(SQL_HANDLE_STMT, stmt, SQLGetData(stmt, column, SQL_CHAR, v, sizeof(v), &ind));
    if (ind == SQL_NULL_DATA) {
      break;
    }
    NAPI_CALL(napi_get_boolean(env, v[0] == 'T', &result));
    return result;
  }
  default:
    return get_chars(env, stmt, column);
  }

  NAPI_CALL(napi_get_null(env, &result));
  return result;
}

// fetch(stmt, kinds, max) -> rows fetches the next rows (at most max, or all
// of them if max is 0), each as an array. Fewer than max rows means that there
// are no more. kinds has a character for how each column is read:
//
//   i  SQL_BIGINT as a number
//   I  SQL_BIGINT as a number (a RangeError if it doesn't fit)
//   b  SQL_BIGINT as a bigint
//   d  SQL_DOUBLE as a number
//   r  SQL_REAL as a number
//   o  SQL_CHAR as a boolean
//   s  SQL_CHAR as a string
//
// A NULL is null.
static napi_value fetch(napi_env env, napi_callback_info info) {
  ARGS(3);
  int32_t stmt, max;
  NAPI_CALL(napi_get_value_int32(env, argv[0], &stmt));
  NAPI_CALL(napi_get_value_int32(env, argv[2], &max));
  char kinds[1024];
  size_t n;
  NAPI_CALL(napi_get_value_string_latin1(env, argv[1], kinds, sizeof(kinds), &n));
  if (n >= sizeof(kinds) - 1) {
    napi_throw_range_error(env, NULL, "too many columns");
    return NULL;
  }

  napi_value rows;
  NAPI_CALL(napi_create_array(env, &rows));
  for (uint32_t r = 0; max == 0 || r < (uint32_t)max; r++) {
    SQLRETURN rc = SQLFetch(stmt);
    if (rc == SQL_NO_DATA) {
      break;
    }
    CHECK(SQL_HANDLE_STMT, stmt, rc);

    napi_value row;
    NAPI_CALL(napi_create_array_with_length(env, n, &row));
    for (size_t i = 0; i < n; i++) {
      napi_value value = get_value(env, stmt, (SQLSMALLINT)(i + 1), kinds[i]);
      if (value == NULL) {
        return NULL;
      }
      NAPI_CALL(napi_set_element(env, row, (uint32_t)i, value));
    }
    NAPI_CALL(napi_set_element(env, rows, r, row));
  }

  return rows;
}

static void free_instance(napi_env env, void *data, void *hint) {
  instance *inst = data;
  if (inst->error_factory != NULL) {
    napi_delete_reference(env, inst->error_factory);
  }
  free(inst);
}

// The constants that the JavaScript code needs.
static const struct {
  const char *name;
  int32_t value;
} constants[] = {
    {"SQL_HANDLE_ENV", SQL_HANDLE_ENV},
    {"SQL_HANDLE_DBC", SQL_HANDLE_DBC},
    {"SQL_HANDLE_STMT", SQL_HANDLE_STMT},
    {"SQL_NULL_HANDLE", SQL_NULL_HANDLE},
    {"SQL_CHAR", SQL_CHAR},
    {"SQL_NUMERIC", SQL_NUMERIC},
    {"SQL_DECIMAL", SQL_DECIMAL},
    {"SQL_INTEGER", SQL_INTEGER},
    {"SQL_SMALLINT", SQL_SMALLINT},
    {"SQL_FLOAT", SQL_FLOAT},
    {"SQL_REAL", SQL_REAL},
    {"SQL_DOUBLE", SQL_DOUBLE},
    {"SQL_VARCHAR", SQL_VARCHAR},
    {"SQL_BOOLEAN", SQL_BOOLEAN},
    {"SQL_BIGINT", SQL_BIGINT},
    {"SQL_TYPE_DATE", SQL_TYPE_DATE},
    {"SQL_TYPE_TIME", SQL_TYPE_TIME},
    {"SQL_TYPE_TIMESTAMP", SQL_TYPE_TIMESTAMP},
    {"SQL_TYPE_TIME_WITH_TIMEZONE", SQL_TYPE_TIME_WITH_TIMEZONE},
    {"SQL_TYPE_TIMESTAMP_WITH_TIMEZONE", SQL_TYPE_TIMESTAMP_WITH_TIMEZONE},
    {"SQL_NO_NULLS", SQL_NO_NULLS},
    {"SQL_NULLABLE", SQL_NULLABLE},
    {"SQL_TRANSACTION_READ_WRITE", SQL_TRANSACTION_READ_WRITE},
    {"SQL_TRANSACTION_READ_COMMITTED", SQL_TRANSACTION_READ_COMMITTED},
    {NULL, 0},
};

NAPI_MODULE_INIT() {
  // The thread that loaded the addon is the only one that's registered with
  // the garbage collector, and only until the first time the addon is
  // initialized (by any thread).
  static int gc_initialized = 0;
  if (!gc_initialized) {
    gc_initialized = 1;
    vsql_gc_after_node_init();
  }

  instance *inst = calloc(1, sizeof(instance));
  if (inst == NULL) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  if (napi_set_instance_data(env, inst, free_instance, NULL) != napi_ok) {
    free(inst);
    return NULL;
  }

  napi_property_descriptor functions[] = {
      {"setErrorFactory", NULL, set_error_factory, NULL, NULL, NULL, napi_default, NULL},
      {"allocHandle", NULL, alloc_handle, NULL, NULL, NULL, napi_default, NULL},
      {"freeHandle", NULL, free_handle, NULL, NULL, NULL, napi_default, NULL},
      {"connect", NULL, connect, NULL, NULL, NULL, napi_default, NULL},
      {"disconnect", NULL, disconnect, NULL, NULL, NULL, napi_default, NULL},
      {"setAutocommit", NULL, set_autocommit, NULL, NULL, NULL, napi_default, NULL},
      {"startTran", NULL, start_tran, NULL, NULL, NULL, napi_default, NULL},
      {"endTran", NULL, end_tran, NULL, NULL, NULL, napi_default, NULL},
      {"execDirect", NULL, exec_direct, NULL, NULL, NULL, napi_default, NULL},
      {"prepare", NULL, prepare, NULL, NULL, NULL, napi_default, NULL},
      {"execute", NULL, execute, NULL, NULL, NULL, napi_default, NULL},
      {"rowCount", NULL, row_count, NULL, NULL, NULL, napi_default, NULL},
      {"numResultCols", NULL, num_result_cols, NULL, NULL, NULL, napi_default, NULL},
      {"describeCol", NULL, describe_col, NULL, NULL, NULL, napi_default, NULL},
      {"closeCursor", NULL, close_cursor, NULL, NULL, NULL, napi_default, NULL},
      {"fetch", NULL, fetch, NULL, NULL, NULL, napi_default, NULL},
  };
  NAPI_CALL(napi_define_properties(env, exports, sizeof(functions) / sizeof(functions[0]),
                                   functions));

  for (int i = 0; constants[i].name != NULL; i++) {
    napi_value value;
    NAPI_CALL(napi_create_int32(env, constants[i].value, &value));
    NAPI_CALL(napi_set_named_property(env, exports, constants[i].name, value));
  }

  return exports;
}
