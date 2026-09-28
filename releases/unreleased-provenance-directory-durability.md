# Unreleased — provenance stores stop syncing every ancestor directory on each write

`ContentObjectStore` and `FilePartitionCommitStore` (`tradeblocks-mcp/market/provenance`) previously fsynced every directory from the target up to `/`, and each one's parent, on every write. Each store instance now syncs a directory, together with its parent's entry for it, when it creates the directory or first meets it, and skips it on later writes while the path still names the same directory (device, inode and birth time). A directory that is removed and recreated is synced again.

What is durable when a write returns is unchanged: the written object, its containing directory, and the entry of every directory on its path. The stores' constructors, methods, results and stored bytes are unchanged. Provenance writes issue far fewer fsyncs, so refresh and publication time depend less on how long the disk takes to flush. This note does not bump a version or publish a release.
