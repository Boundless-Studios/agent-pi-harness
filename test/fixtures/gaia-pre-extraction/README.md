# Gaia pre-extraction fixture

This fixture records the runtime surface at the parent of Gaia merge commit
`a6fafb8c4c`. The hashes are used only for the initial move/parity checkpoint;
after the adapter boundary is introduced, exported behavior fixtures replace
source-layout hashes.

The fixture was captured with:

```text
git -C /Users/ilya/code/gaia-free show a6fafb8c4c^:<path> | shasum -a 256
```
