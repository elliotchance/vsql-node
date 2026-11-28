# binding.gyp builds the vsql addon (src/binding.c), which compiles libvsql from
# the amalgamation in internal/amalgamation (see scripts/update-amalgamation.sh)
# with the libraries that V used for each OS and architecture
# (libvsql_flags.gypi). libvsql.c is the C for every OS and architecture, and
# defines what it needs for the one it's compiled on itself.
{
  'includes': ['libvsql_flags.gypi'],
  'targets': [
    {
      'target_name': 'vsql',
      'sources': [
        'src/binding.c',
        'internal/amalgamation/libvsql.c',
      ],
      'include_dirs': ['internal/amalgamation'],
      # The garbage collector in libvsql doesn't install pthread_atfork
      # handlers. Node only forks to execute another program, and the handler
      # for the child crashes (on Linux), since the thread that loaded the
      # addon isn't registered with the collector (see binding.c).
      'defines': ['NAPI_VERSION=8', 'NO_HANDLE_FORK'],
      'conditions': [
        ['OS=="win"', {
          # The C that V generates uses GNU C (such as statement expressions),
          # which MSVC can't compile, so it's compiled with clang-cl instead.
          # The rest of MSVC (the linker and the headers) is still used.
          'msbuild_toolset': 'ClangCL',
          # node-gyp links every addon with ODBC, which has the same routines
          # (such as SQLAllocHandle) as libvsql.
          'libraries!': ['-lodbc32.lib'],
          'msvs_settings': {
            'VCCLCompilerTool': {
              # V's C relies on signed overflow wrapping (-fwrapv).
              'AdditionalOptions': ['/w', '/clang:-fwrapv'],
              # Node's common.gypi gives the C++ standard to every file, which
              # clang-cl doesn't allow for C. A Node built with clang (such as
              # Node 26) also gives the profile it was optimized with, which
              # only exists where Node was built.
              'AdditionalOptions/': [
                ['exclude', '^[-/]std:c\\+\\+'],
                ['exclude', '^-fprofile-'],
              ],
            },
            'VCLinkerTool': {
              'AdditionalOptions/': [['exclude', '^-fprofile-']],
            },
          },
        }, {
          # The options from the amalgamation's Makefile: V's C relies on
          # signed overflow wrapping and causes many warnings. The C that V
          # generates for Linux also passes a pthread_t as a void*, which is
          # an error from GCC 14 unless -Wno-int-conversion is given.
          'cflags': ['-fwrapv', '-w', '-Wno-int-conversion'],
          'cflags_c': ['-std=gnu11'],
          'xcode_settings': {
            'GCC_C_LANGUAGE_STANDARD': 'gnu11',
            'OTHER_CFLAGS': ['-fwrapv', '-w', '-Wno-int-conversion'],
          },
        }],
        ['OS=="linux"', {
          # The Boehm GC in libvsql finds the data segments of the shared
          # libraries with dl_iterate_phdr. Without it, the GC can't find them
          # with musl (such as Alpine), and fails with "Wrong DATASTART/END
          # pair".
          'defines': ['HAVE_DL_ITERATE_PHDR', 'DL_ITERATE_PHDR_STRONG'],
        }],
      ],
    },
  ],
}
