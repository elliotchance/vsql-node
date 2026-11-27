// fault.h makes the calls of src/binding.c fail on purpose, so that the tests
// (test/coverage.test.js) can run the code that handles each failure.
// scripts/coverage.sh compiles binding.c with it (-include test/fault.h). It's
// never in the addon that's published.
//
// When VSQL_NODE_FAULT is "name:n", the nth call (counting from when it was
// set) to malloc, calloc, a Node-API function (except the ones that throw, or
// read the last error) or a libvsql routine fails, and VSQL_NODE_FAULTED is
// set to "1". A Node-API function returns napi_generic_failure, a libvsql
// routine returns SQL_ERROR (without calling it, so there's no diagnostic
// record), and malloc and calloc return NULL. Each name:n is counted from 0
// again.

#ifndef VSQL_NODE_FAULT_H
#define VSQL_NODE_FAULT_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <node_api.h>

#include "libvsql.h"

static int vsql_node_fault(void) {
  static char last[64];
  static long count, at;
  const char *value = getenv("VSQL_NODE_FAULT");
  if (value == NULL) {
    last[0] = '\0';
    return 0;
  }
  if (strcmp(value, last) != 0) {
    snprintf(last, sizeof(last), "%s", value);
    const char *colon = strchr(value, ':');
    at = colon == NULL ? 0 : strtol(colon + 1, NULL, 10);
    count = 0;
  }
  if (++count != at) {
    return 0;
  }

  setenv("VSQL_NODE_FAULTED", "1", 1);
  return 1;
}

#define malloc(...) (vsql_node_fault() ? NULL : malloc(__VA_ARGS__))
#define calloc(...) (vsql_node_fault() ? NULL : calloc(__VA_ARGS__))

#define napi_call_function(...) (vsql_node_fault() ? napi_generic_failure : napi_call_function(__VA_ARGS__))
#define napi_create_array(...) (vsql_node_fault() ? napi_generic_failure : napi_create_array(__VA_ARGS__))
#define napi_create_array_with_length(...) (vsql_node_fault() ? napi_generic_failure : napi_create_array_with_length(__VA_ARGS__))
#define napi_create_bigint_int64(...) (vsql_node_fault() ? napi_generic_failure : napi_create_bigint_int64(__VA_ARGS__))
#define napi_create_buffer_copy(...) (vsql_node_fault() ? napi_generic_failure : napi_create_buffer_copy(__VA_ARGS__))
#define napi_create_double(...) (vsql_node_fault() ? napi_generic_failure : napi_create_double(__VA_ARGS__))
#define napi_create_int32(...) (vsql_node_fault() ? napi_generic_failure : napi_create_int32(__VA_ARGS__))
#define napi_create_object(...) (vsql_node_fault() ? napi_generic_failure : napi_create_object(__VA_ARGS__))
#define napi_create_reference(...) (vsql_node_fault() ? napi_generic_failure : napi_create_reference(__VA_ARGS__))
#define napi_create_string_utf8(...) (vsql_node_fault() ? napi_generic_failure : napi_create_string_utf8(__VA_ARGS__))
#define napi_define_properties(...) (vsql_node_fault() ? napi_generic_failure : napi_define_properties(__VA_ARGS__))
#define napi_delete_reference(...) (vsql_node_fault() ? napi_generic_failure : napi_delete_reference(__VA_ARGS__))
#define napi_get_array_length(...) (vsql_node_fault() ? napi_generic_failure : napi_get_array_length(__VA_ARGS__))
#define napi_get_boolean(...) (vsql_node_fault() ? napi_generic_failure : napi_get_boolean(__VA_ARGS__))
#define napi_get_cb_info(...) (vsql_node_fault() ? napi_generic_failure : napi_get_cb_info(__VA_ARGS__))
#define napi_get_element(...) (vsql_node_fault() ? napi_generic_failure : napi_get_element(__VA_ARGS__))
#define napi_get_global(...) (vsql_node_fault() ? napi_generic_failure : napi_get_global(__VA_ARGS__))
#define napi_get_instance_data(...) (vsql_node_fault() ? napi_generic_failure : napi_get_instance_data(__VA_ARGS__))
#define napi_get_null(...) (vsql_node_fault() ? napi_generic_failure : napi_get_null(__VA_ARGS__))
#define napi_get_reference_value(...) (vsql_node_fault() ? napi_generic_failure : napi_get_reference_value(__VA_ARGS__))
#define napi_get_typedarray_info(...) (vsql_node_fault() ? napi_generic_failure : napi_get_typedarray_info(__VA_ARGS__))
#define napi_get_undefined(...) (vsql_node_fault() ? napi_generic_failure : napi_get_undefined(__VA_ARGS__))
#define napi_get_value_bigint_int64(...) (vsql_node_fault() ? napi_generic_failure : napi_get_value_bigint_int64(__VA_ARGS__))
#define napi_get_value_bool(...) (vsql_node_fault() ? napi_generic_failure : napi_get_value_bool(__VA_ARGS__))
#define napi_get_value_double(...) (vsql_node_fault() ? napi_generic_failure : napi_get_value_double(__VA_ARGS__))
#define napi_get_value_int32(...) (vsql_node_fault() ? napi_generic_failure : napi_get_value_int32(__VA_ARGS__))
#define napi_get_value_int64(...) (vsql_node_fault() ? napi_generic_failure : napi_get_value_int64(__VA_ARGS__))
#define napi_get_value_string_latin1(...) (vsql_node_fault() ? napi_generic_failure : napi_get_value_string_latin1(__VA_ARGS__))
#define napi_get_value_string_utf8(...) (vsql_node_fault() ? napi_generic_failure : napi_get_value_string_utf8(__VA_ARGS__))
#define napi_set_element(...) (vsql_node_fault() ? napi_generic_failure : napi_set_element(__VA_ARGS__))
#define napi_set_instance_data(...) (vsql_node_fault() ? napi_generic_failure : napi_set_instance_data(__VA_ARGS__))
#define napi_set_named_property(...) (vsql_node_fault() ? napi_generic_failure : napi_set_named_property(__VA_ARGS__))
#define napi_typeof(...) (vsql_node_fault() ? napi_generic_failure : napi_typeof(__VA_ARGS__))

#define SQLAllocHandle(...) (vsql_node_fault() ? SQL_ERROR : SQLAllocHandle(__VA_ARGS__))
#define SQLBindParameter(...) (vsql_node_fault() ? SQL_ERROR : SQLBindParameter(__VA_ARGS__))
#define SQLCloseCursor(...) (vsql_node_fault() ? SQL_ERROR : SQLCloseCursor(__VA_ARGS__))
#define SQLConnect(...) (vsql_node_fault() ? SQL_ERROR : SQLConnect(__VA_ARGS__))
#define SQLDescribeCol(...) (vsql_node_fault() ? SQL_ERROR : SQLDescribeCol(__VA_ARGS__))
#define SQLDisconnect(...) (vsql_node_fault() ? SQL_ERROR : SQLDisconnect(__VA_ARGS__))
#define SQLEndTran(...) (vsql_node_fault() ? SQL_ERROR : SQLEndTran(__VA_ARGS__))
#define SQLExecute(...) (vsql_node_fault() ? SQL_ERROR : SQLExecute(__VA_ARGS__))
#define SQLFetch(...) (vsql_node_fault() ? SQL_ERROR : SQLFetch(__VA_ARGS__))
#define SQLFreeHandle(...) (vsql_node_fault() ? SQL_ERROR : SQLFreeHandle(__VA_ARGS__))
#define SQLFreeStmt(...) (vsql_node_fault() ? SQL_ERROR : SQLFreeStmt(__VA_ARGS__))
#define SQLGetData(...) (vsql_node_fault() ? SQL_ERROR : SQLGetData(__VA_ARGS__))
#define SQLGetDescField(...) (vsql_node_fault() ? SQL_ERROR : SQLGetDescField(__VA_ARGS__))
#define SQLGetDiagField(...) (vsql_node_fault() ? SQL_ERROR : SQLGetDiagField(__VA_ARGS__))
#define SQLGetDiagRec(...) (vsql_node_fault() ? SQL_ERROR : SQLGetDiagRec(__VA_ARGS__))
#define SQLGetInfo(...) (vsql_node_fault() ? SQL_ERROR : SQLGetInfo(__VA_ARGS__))
#define SQLGetStmtAttr(...) (vsql_node_fault() ? SQL_ERROR : SQLGetStmtAttr(__VA_ARGS__))
#define SQLNumResultCols(...) (vsql_node_fault() ? SQL_ERROR : SQLNumResultCols(__VA_ARGS__))
#define SQLPrepare(...) (vsql_node_fault() ? SQL_ERROR : SQLPrepare(__VA_ARGS__))
#define SQLRowCount(...) (vsql_node_fault() ? SQL_ERROR : SQLRowCount(__VA_ARGS__))
#define SQLSetConnectAttr(...) (vsql_node_fault() ? SQL_ERROR : SQLSetConnectAttr(__VA_ARGS__))
#define SQLStartTran(...) (vsql_node_fault() ? SQL_ERROR : SQLStartTran(__VA_ARGS__))

#endif
