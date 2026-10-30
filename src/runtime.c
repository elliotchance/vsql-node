// runtime.c compiles the garbage collector and V's helpers from the
// amalgamation, which have to be compiled separately from libvsql.c (see
// internal/amalgamation/vsql_runtime.c).
#include "vsql_runtime.c"

// vsql_gc_after_node_init is called when the addon is loaded (see binding.c).
// libvsql initializes the garbage collector from a C constructor, when the
// addon is loaded, which registers the thread that loaded it with the
// collector for good. So the collector could stop that thread, or scan its
// stack, while it's running JavaScript. Every other thread is only registered
// while it's in a libvsql routine, and after this that thread is too.
//
// Unlike Go, Node doesn't replace the signal handlers that the collector uses
// to stop threads on Linux (SIGPWR and SIGXCPU), unless the program listens
// for them with process.on.
void vsql_gc_after_node_init(void) {
  if (GC_thread_is_registered()) {
    GC_unregister_my_thread();
  }
}
