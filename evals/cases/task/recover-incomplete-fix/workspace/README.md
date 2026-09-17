# Shared slug contract

Both project slugs and user slugs follow the same contract:

- remove leading and trailing whitespace;
- convert letters to lowercase;
- replace each run of whitespace with one hyphen.

The named export remains `normalizeSlug` at both implementation sites.
