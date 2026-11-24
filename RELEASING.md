# Reproducible releases

The agent has no dependencies and no build step, so the release artefact is just the source.

1. Tag: `git tag agent-v0.1.0`.
2. Build: `npm pack` (npm normalises file timestamps and ordering, so the same source yields the same tarball).
3. Checksum: `sha256sum arcade-research-agent-0.1.0.tgz > SHA256SUMS` and publish both with the GitHub release.
4. Anyone can verify by checking out the tag, running `npm pack` with the same npm major version and comparing the hash.
