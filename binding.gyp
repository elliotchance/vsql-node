# binding.gyp builds the vsql addon (src/binding.c), which compiles libvsql from
# the amalgamation in internal/amalgamation (see scripts/update-amalgamation.sh)
# with the defines and libraries that V used for each OS and architecture
# (libvsql_flags.gypi).
{
  'includes': ['libvsql_flags.gypi'],
  'targets': [
    {
      'target_name': 'vsql',
      'sources': [
        'src/binding.c',
        'src/runtime.c',
        'internal/amalgamation/libvsql.c',
      ],
      'include_dirs': ['internal/amalgamation'],
      'defines': ['NAPI_VERSION=8'],
      'conditions': [
        ['OS=="win"', {
          # The C that V generates uses GNU C (such as statement expressions),
          # which MSVC can't compile, so it's compiled with clang-cl instead.
          # The rest of MSVC (the linker and the headers) is still used.
          'msbuild_toolset': 'ClangCL',
          # The C that V generates doesn't include stdio.h with clang, and
          # defines the buffering modes as glibc's values when they aren't
          # defined. These are the UCRT's, otherwise setvbuf (from V's
          # initialization, in the first SQLAllocHandle) is an invalid
          # parameter, which ends the process.
          'defines': ['_IOFBF=0x0000', '_IOLBF=0x0040', '_IONBF=0x0004'],
          # node-gyp links every addon with ODBC, which has the same routines
          # (such as SQLAllocHandle) as libvsql.
          'libraries!': ['-lodbc32.lib'],
          'msvs_settings': {
            'VCCLCompilerTool': {
              'AdditionalOptions': ['/w'],
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
          # The C that V generates for Linux passes a pthread_t as a void*,
          # which is an error from GCC 14 unless -Wno-int-conversion is given.
          'cflags': ['-w', '-Wno-int-conversion'],
          'cflags_c': ['-std=gnu11'],
          'xcode_settings': {
            'GCC_C_LANGUAGE_STANDARD': 'gnu11',
            'OTHER_CFLAGS': ['-w', '-Wno-int-conversion'],
          },
        }],
      ],
    },
  ],
}
