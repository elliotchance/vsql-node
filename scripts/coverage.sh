#!/bin/sh
# coverage.sh runs the tests and fails unless they cover all of lib (lines,
# branches and functions, measured by node --test) and src/binding.c (lines,
# measured by gcov).
#
# The addon is compiled here (rather than by node-gyp) so that only binding.c
# is compiled with --coverage, and with test/fault.h, which can make each call
# that it makes fail (see test/coverage.test.js, which only runs when
# VSQL_NODE_COVERAGE is set). libvsql.c is compiled once, and again only when it
# changes.
#
# The test files are run one at a time, since gcov's counts can be lost when
# processes write them at the same time.
set -eu
cd "$(dirname "$0")/.."

out=build/coverage
mkdir -p "$out" build/Release
rm -f "$out"/*.gcda "$out"/*.gcov

cc=${CC:-cc}
include=$(node -p 'require("path").resolve(process.execPath, "../../include/node")')
case "$(uname)" in
  Darwin) link="-bundle -undefined dynamic_lookup" ;;
  *) link="-shared" ;;
esac

if [ ! -f "$out/libvsql.o" ] || [ internal/amalgamation/libvsql.c -nt "$out/libvsql.o" ]; then
  echo "compiling libvsql.c"
  # NO_HANDLE_FORK: the garbage collector's fork handlers crash processes that
  # are spawned after the addon is loaded (#32).
  $cc -std=gnu11 -fwrapv -w -fPIC -O1 -DNO_HANDLE_FORK -c internal/amalgamation/libvsql.c \
    -o "$out/libvsql.o"
fi
$cc -std=gnu11 -fPIC -O0 --coverage -include test/fault.h -DNAPI_VERSION=8 -I"$include" \
  -Iinternal/amalgamation -c src/binding.c -o "$out/binding.o"
# shellcheck disable=SC2086
$cc $link --coverage -o build/Release/vsql.node "$out/binding.o" "$out/libvsql.o" \
  -lpthread -lm

VSQL_NODE_COVERAGE=1 node --expose-gc --test --test-concurrency=1 \
  --experimental-test-coverage \
  --test-coverage-include='lib/**' \
  --test-coverage-lines=100 --test-coverage-branches=100 \
  --test-coverage-functions=100

# gcov prints "Lines executed:N% of M" for binding.c, and writes
# binding.c.gcov with ##### on each line that wasn't run.
summary=$(${GCOV:-gcov} -o "$out" src/binding.c | grep -A1 "src/binding.c'" | grep 'Lines executed')
mv ./*.gcov "$out/"
echo "src/binding.c: $summary"
case "$summary" in
  *100.00%*) ;;
  *)
    grep '#####' "$out/binding.c.gcov" || true
    echo "src/binding.c isn't covered by the tests (the lines above weren't run)"
    exit 1
    ;;
esac
