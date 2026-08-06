# Vendored build inputs

These archives are build-only inputs. They are compiled into `dist/vendor/` by
`scripts/build-vendor.mjs` and are not shipped as nested npm dependencies.
Runtime and native packages such as React and Koffi remain ordinary registry
dependencies of portal.

| Archive               | Source commit                                                     | SHA-256                                                            |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ink-7.1.0.tgz`       | `kabxx/ink4portal@ce12936c40d2b713c5d279053619b814cb91fa4d`       | `b537101a3905ce23c5399fb226b4af0511381ad994cd9ab968fd3edba9b8308a` |
| `markdansi-0.3.2.tgz` | `kabxx/Markdansi4portal@c2303ded5393b13c3cb24944be3f7bd9bac670f6` | `3fc79ccdca4cbd048c0d39eba3f644de52b0cd4d3b2404935ae0a3c040a7fbec` |

To update an archive, check out the recorded source repository in a clean
worktree, install its development dependencies, run its normal build command,
and create the archive with `npm pack --ignore-scripts`. Replace the archive,
update its `file:` version in `package.json`, run `npm install` to refresh the
lockfile, update this provenance table, and run the complete package smoke test
on the generated portal tarball.

`licenses/yoga-layout-3.2.1.LICENSE` is the MIT license from the matching
`facebook/yoga@v3.2.1` source tag. The `yoga-layout` npm archive omits that
file, so the vendor build uses this pinned fallback and fails if any other
bundled package lacks license text.
